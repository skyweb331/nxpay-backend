#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/02009c53c6af9a35fcffcfdb3072c301f05869af8b197c895045eac4c44b0228/contract';
import endContract from '../../snapshots/02009c53c6af9a35fcffcfdb3072c301f05869af8b197c895045eac4c44b0228/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/e42e77210363488fd60067b61fc9eeabd25ed2fa8566223b21743d95e9e1063e/contract';
import startContract from '../../snapshots/e42e77210363488fd60067b61fc9eeabd25ed2fa8566223b21743d95e9e1063e/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'customers',
        column: col('verifiedAt', 'timestamptz(3)', {
          codecRef: { codecId: 'pg/timestamptz-date@1', typeParams: { precision: 3 } },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'customers',
        column: col('verifiedCountry', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'customers',
        column: col('verifiedFirstName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'customers',
        column: col('verifiedLastName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'customers',
        column: col('verifiedRegion', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
