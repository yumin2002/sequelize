import mapValues from 'lodash/mapValues.js';
import * as DataTypes from '../../data-types.js';
import type { Expression } from '../../sequelize.js';
import { isString } from '../../utils/check.js';
import { generateSequenceName } from '../../utils/format.js';
import { joinSQLFragments } from '../../utils/join-sql-fragments';
import { generateIndexName } from '../../utils/string';
import type { DataTypeInstance } from '../abstract/data-types.js';
import { AbstractDataType } from '../abstract/data-types.js';
import { AbstractQueryGenerator } from '../abstract/query-generator';
import { normalizeChangeColumnAttribute } from '../abstract/query-generator-internal.js';
import type { EscapeOptions, RemoveIndexQueryOptions, TableNameOrModel } from '../abstract/query-generator-typescript';
import type { ChangeColumnDefinitions, ShowConstraintsQueryOptions } from '../abstract/query-generator.types';
import type { DbObjectId } from '../abstract/query-interface';
import { ENUM } from './data-types.js';
import { PostgresQueryGeneratorInternal } from './query-generator-internal.js';
import type { PostgresDialect } from './index.js';

export interface CreateEnumQueryOptions {
  /**
   * Drop the existing enum if one exists
   */
  force?: boolean | undefined;
}

export interface ListEnumQueryOptions {
  /**
   * The schema for which to list the enums, defaults to the default schema of the Sequelize instance.
   */
  schema?: string | undefined;

  /**
   * The name of the enum to list, defaults to all enums in the schema.
   */
  dataTypeOrName?: DataTypeInstance | string | undefined;
}

export interface AddValueToEnumQueryOptions {
  /**
   * Before which value of the enum the new value should be inserted.
   */
  before?: string | undefined;

  /**
   * After which value of the enum the new value should be inserted.
   */
  after?: string | undefined;
}

/**
 * Temporary class to ease the TypeScript migration
 */
export class PostgresQueryGeneratorTypeScript extends AbstractQueryGenerator {
  readonly #internalQueryGenerator: PostgresQueryGeneratorInternal;

  constructor(dialect: PostgresDialect, internalQueryGenerator?: PostgresQueryGeneratorInternal) {
    internalQueryGenerator = internalQueryGenerator ?? new PostgresQueryGeneratorInternal(dialect);

    super(dialect, internalQueryGenerator);

    this.#internalQueryGenerator = internalQueryGenerator;
  }

  describeTableQuery(tableName: TableNameOrModel) {
    const table = this.extractTableDetails(tableName);

    return joinSQLFragments([
      'SELECT',
      'pk.constraint_type as "Constraint",',
      'c.column_name as "Field",',
      'c.column_default as "Default",',
      'c.is_nullable as "Null",',
      `(CASE WHEN c.udt_name = 'hstore' THEN UPPER(c.udt_name) WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE UPPER(c.data_type) END) || (CASE WHEN c.character_maximum_length IS NOT NULL THEN '(' || c.character_maximum_length || ')' ELSE '' END) as "Type",`,
      '(SELECT pgd.description FROM pg_catalog.pg_statio_all_tables AS st INNER JOIN pg_catalog.pg_description pgd on (pgd.objoid=st.relid) WHERE c.ordinal_position=pgd.objsubid AND c.table_name=st.relname) AS "Comment"',
      'FROM information_schema.columns c',
      'LEFT JOIN (SELECT tc.table_schema, tc.table_name,',
      'cu.column_name, tc.constraint_type',
      'FROM information_schema.TABLE_CONSTRAINTS tc',
      'JOIN information_schema.KEY_COLUMN_USAGE  cu',
      'ON tc.table_schema=cu.table_schema and tc.table_name=cu.table_name',
      'and tc.constraint_name=cu.constraint_name',
      `and tc.constraint_type='PRIMARY KEY') pk`,
      'ON pk.table_schema=c.table_schema',
      'AND pk.table_name=c.table_name',
      'AND pk.column_name=c.column_name',
      `WHERE c.table_name = ${this.escape(table.tableName)}`,
      `AND c.table_schema = ${this.escape(table.schema)}`,
    ]);
  }

  showConstraintsQuery(tableName: TableNameOrModel, options?: ShowConstraintsQueryOptions) {
    const table = this.extractTableDetails(tableName);

    // Postgres converts camelCased alias to lowercase unless quoted
    return joinSQLFragments([
      'SELECT c.constraint_catalog AS "constraintCatalog",',
      'c.constraint_schema AS "constraintSchema",',
      'c.constraint_name AS "constraintName",',
      'c.constraint_type AS "constraintType",',
      'c.table_catalog AS "tableCatalog",',
      'c.table_schema AS "tableSchema",',
      'c.table_name AS "tableName",',
      'kcu.column_name AS "columnNames",',
      'ccu.table_schema AS "referencedTableSchema",',
      'ccu.table_name AS "referencedTableName",',
      'ccu.column_name AS "referencedColumnNames",',
      'r.delete_rule AS "deleteAction",',
      'r.update_rule AS "updateAction",',
      'ch.check_clause AS "definition",',
      'c.is_deferrable AS "isDeferrable",',
      'c.initially_deferred AS "initiallyDeferred"',
      'FROM INFORMATION_SCHEMA.table_constraints c',
      'LEFT JOIN INFORMATION_SCHEMA.referential_constraints r ON c.constraint_catalog = r.constraint_catalog AND c.constraint_schema = r.constraint_schema AND c.constraint_name = r.constraint_name',
      'LEFT JOIN INFORMATION_SCHEMA.key_column_usage kcu ON r.constraint_catalog = kcu.constraint_catalog AND r.constraint_schema = kcu.constraint_schema AND r.constraint_name = kcu.constraint_name',
      'LEFT JOIN information_schema.constraint_column_usage AS ccu ON r.constraint_catalog = ccu.constraint_catalog AND r.constraint_schema = ccu.constraint_schema AND r.constraint_name = ccu.constraint_name',
      'LEFT JOIN INFORMATION_SCHEMA.check_constraints ch ON c.constraint_catalog = ch.constraint_catalog AND c.constraint_schema = ch.constraint_schema AND c.constraint_name = ch.constraint_name',
      `WHERE c.table_name = ${this.escape(table.tableName)}`,
      `AND c.table_schema = ${this.escape(table.schema)}`,
      options?.constraintName ? `AND c.constraint_name = ${this.escape(options.constraintName)}` : '',
      'ORDER BY c.constraint_name, kcu.ordinal_position',
    ]);
  }

  showIndexesQuery(tableName: TableNameOrModel) {
    const table = this.extractTableDetails(tableName);

    // TODO [>=6]: refactor the query to use pg_indexes
    return joinSQLFragments([
      'SELECT i.relname AS name, ix.indisprimary AS primary, ix.indisunique AS unique, ix.indkey[:ix.indnkeyatts-1] AS index_fields,',
      'ix.indkey[ix.indnkeyatts:] AS include_fields, array_agg(a.attnum) as column_indexes, array_agg(a.attname) AS column_names,',
      'pg_get_indexdef(ix.indexrelid) AS definition FROM pg_class t, pg_class i, pg_index ix, pg_attribute a , pg_namespace s',
      'WHERE t.oid = ix.indrelid AND i.oid = ix.indexrelid AND a.attrelid = t.oid AND',
      `t.relkind = 'r' and t.relname = ${this.escape(table.tableName)}`,
      `AND s.oid = t.relnamespace AND s.nspname = ${this.escape(table.schema)}`,
      'GROUP BY i.relname, ix.indexrelid, ix.indisprimary, ix.indisunique, ix.indkey, ix.indnkeyatts ORDER BY i.relname;',
    ]);
  }

  removeIndexQuery(
    tableName: TableNameOrModel,
    indexNameOrAttributes: string | string[],
    options?: RemoveIndexQueryOptions,
  ) {
    if (options?.cascade && options?.concurrently) {
      throw new Error(`Cannot specify both concurrently and cascade options in removeIndexQuery for ${this.dialect.name} dialect`);
    }

    let indexName;
    const table = this.extractTableDetails(tableName);
    if (Array.isArray(indexNameOrAttributes)) {
      indexName = generateIndexName(table, { fields: indexNameOrAttributes });
    } else {
      indexName = indexNameOrAttributes;
    }

    return joinSQLFragments([
      'DROP INDEX',
      options?.concurrently ? 'CONCURRENTLY' : '',
      options?.ifExists ? 'IF EXISTS' : '',
      `${this.quoteIdentifier(table.schema)}.${this.quoteIdentifier(indexName)}`,
      options?.cascade ? 'CASCADE' : '',
    ]);
  }

  getForeignKeyQuery(tableName: TableNameOrModel, columnName?: string) {
    const table = this.extractTableDetails(tableName);

    return joinSQLFragments([
      // conkey and confkey are arrays for composite foreign keys.
      // This splits them as matching separate rows
      'WITH unnested_pg_constraint AS (',
      'SELECT conname, confrelid, connamespace, conrelid, contype, oid,',
      'unnest(conkey) AS conkey, unnest(confkey) AS confkey',
      'FROM pg_constraint)',
      'SELECT "constraint".conname as "constraintName",',
      'constraint_schema.nspname as "constraintSchema",',
      'current_database() as "constraintCatalog",',
      '"table".relname as "tableName",',
      'table_schema.nspname as "tableSchema",',
      'current_database() as "tableCatalog",',
      '"column".attname as "columnName",',
      'referenced_table.relname as "referencedTableName",',
      'referenced_schema.nspname as "referencedTableSchema",',
      'current_database() as "referencedTableCatalog",',
      '"referenced_column".attname as "referencedColumnName"',
      'FROM unnested_pg_constraint "constraint"',
      'INNER JOIN pg_catalog.pg_class referenced_table ON',
      'referenced_table.oid = "constraint".confrelid',
      'INNER JOIN pg_catalog.pg_namespace referenced_schema ON',
      'referenced_schema.oid = referenced_table.relnamespace',
      'INNER JOIN pg_catalog.pg_namespace constraint_schema ON',
      '"constraint".connamespace = constraint_schema.oid',
      'INNER JOIN pg_catalog.pg_class "table" ON "constraint".conrelid = "table".oid',
      'INNER JOIN pg_catalog.pg_namespace table_schema ON "table".relnamespace = table_schema.oid',
      'INNER JOIN pg_catalog.pg_attribute "column" ON',
      '"column".attnum = "constraint".conkey AND "column".attrelid = "constraint".conrelid',
      'INNER JOIN pg_catalog.pg_attribute "referenced_column" ON',
      '"referenced_column".attnum = "constraint".confkey AND',
      '"referenced_column".attrelid = "constraint".confrelid',
      `WHERE "constraint".contype = 'f'`,
      `AND "table".relname = ${this.escape(table.tableName)}`,
      `AND table_schema.nspname = ${this.escape(table.schema)}`,
      columnName && `AND "column".attname = ${this.escape(columnName)};`,
    ]);
  }

  jsonPathExtractionQuery(sqlExpression: string, path: ReadonlyArray<number | string>, unquote: boolean): string {
    const operator = path.length === 1
      ? (unquote ? '->>' : '->')
      : (unquote ? '#>>' : '#>');

    const pathSql = path.length === 1
      // when accessing an array index with ->, the index must be a number
      // when accessing an object key with ->, the key must be a string
      ? this.escape(path[0])
      // when accessing with #>, the path is always an array of strings
      : this.escape(path.map(value => String(value)));

    return sqlExpression + operator + pathSql;
  }

  formatUnquoteJson(arg: Expression, options?: EscapeOptions) {
    return `${this.escape(arg, options)}#>>ARRAY[]::TEXT[]`;
  }

  versionQuery() {
    return 'SHOW SERVER_VERSION';
  }

  changeColumnsQuery(tableOrModel: TableNameOrModel, columnDefinitions: ChangeColumnDefinitions): string {
    const sql = super.changeColumnsQuery(tableOrModel, columnDefinitions);

    const normalizedChangeColumnDefinitions = mapValues(columnDefinitions, attribute => {
      return normalizeChangeColumnAttribute(this.sequelize, attribute);
    });

    const table = this.extractTableDetails(tableOrModel);

    const out = [];
    if (sql) {
      out.push(sql);
    }

    for (const [columnName, columnDef] of Object.entries(normalizedChangeColumnDefinitions)) {
      if ('comment' in columnDef) {
        if (columnDef.comment == null) {
          out.push(`COMMENT ON COLUMN ${this.quoteTable(table)}.${this.quoteIdentifier(columnName)} IS NULL;`);
        } else {
          out.push(`COMMENT ON COLUMN ${this.quoteTable(table)}.${this.quoteIdentifier(columnName)} IS ${this.escape(columnDef.comment)};`);
        }
      }

      if (columnDef.autoIncrement) {
        out.unshift(`CREATE SEQUENCE IF NOT EXISTS ${this.quoteIdentifier(generateSequenceName(table.tableName, columnName))} OWNED BY ${this.quoteTable(table)}.${this.quoteIdentifier(columnName)};`);
      }

      const enumType = columnDef.type instanceof DataTypes.ARRAY ? columnDef.type.options.type : columnDef.type;
      if (enumType instanceof DataTypes.ENUM) {
        // tell the enum in which context it is used so its name generation has all the necessary information.
        const typeWithContext = enumType.withUsageContext({
          columnName,
          sequelize: this.sequelize,
          tableName: table,
        });

        // create enum under a temporary name
        out.unshift(this.createEnumQuery(typeWithContext));
      }
    }

    return out.join(' ');
  }

  createEnumQuery(
    dataType: DataTypeInstance,
    options?: CreateEnumQueryOptions,
  ): string {
    if (!(dataType instanceof ENUM)) {
      throw new TypeError('createEnumQuery expects an instance of the ENUM DataType');
    }

    const enumName = dataType.getEnumName();
    const values = `ENUM(${dataType.options.values.map(value => this.escape(value))
      .join(', ')})`;

    let sql = `DO ${this.escape(`BEGIN CREATE TYPE ${this.quoteIdentifierWithDefaults(enumName)} AS ${values}; EXCEPTION WHEN duplicate_object THEN null; END`)};`;
    if (options?.force === true) {
      sql = `${this.dropEnumQuery(enumName)}\n${sql}`;
    }

    return sql;
  }

  dropEnumQuery(dataTypeOrName: DataTypeInstance | DbObjectId): string {
    const enumName = dataTypeOrName instanceof AbstractDataType ? dataTypeOrName.toSql()
        : this.quoteIdentifierWithDefaults(dataTypeOrName);

    return `DROP TYPE IF EXISTS ${enumName};`;
  }

  listEnumsQuery(options?: ListEnumQueryOptions) {
    const enumName = !options?.dataTypeOrName ? ''
      : isString(options.dataTypeOrName) ? options.dataTypeOrName
      : options.dataTypeOrName.toSql();

    const enumNameFilter = enumName ? ` AND t.typname=${this.escape(enumName)}` : '';

    const schema = options?.schema || this.options.schema || this.dialect.getDefaultSchema();

    return 'SELECT t.typname name, array_agg(e.enumlabel ORDER BY enumsortorder) values FROM pg_type t '
      + 'JOIN pg_enum e ON t.oid = e.enumtypid '
      + 'JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace '
      + `WHERE n.nspname = ${this.escape(schema)}${enumNameFilter} GROUP BY 1`;
  }

  addValueToEnumQuery(
    dataTypeOrName: DataTypeInstance | DbObjectId,
    value: string,
    options?: AddValueToEnumQueryOptions,
  ): string {
    const enumName = dataTypeOrName instanceof AbstractDataType ? dataTypeOrName.toSql()
      : this.quoteIdentifierWithDefaults(dataTypeOrName);

    let sql = `ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS ${this.escape(value)}`;

    if (options?.before) {
      sql += ` BEFORE ${this.escape(options.before)}`;
    } else if (options?.after) {
      sql += ` AFTER ${this.escape(options.after)}`;
    }

    return sql;
  }
}
