import DataLoader from 'dataloader';

import type RootDataLoader from './index.js';
import { groupBy, indexBy, uniq } from './utils.js';
import type {
  CustodialWalletRow,
  MicrodepositRow,
  VirtualAccountRow,
  WalletRow,
} from '#src/service/prisma.js';

export const walletLoader = (parent: RootDataLoader) => {
  return new DataLoader<string, WalletRow | null>(
    async (ids) => {
      const rows = await parent.prisma.orm.Wallet.where((w) => w.id.in(uniq(ids))).all();
      return indexBy(ids, rows, (w) => w.id);
    },
    { ...parent.dataLoaderOptions }
  );
};

export const walletsForCustomerLoader = (parent: RootDataLoader) => {
  return new DataLoader<string, WalletRow[]>(
    async (customerIds) => {
      const rows = await parent.prisma.orm.Wallet.where((w) => w.customerId.in(uniq(customerIds)))
        .orderBy((w) => w.id.asc())
        .all();
      return groupBy(customerIds, rows, (w) => w.customerId);
    },
    { ...parent.dataLoaderOptions }
  );
};

/** Wallet ids that still have a stored (encrypted) key. Never loads key material. */
export const walletHasKeyLoader = (parent: RootDataLoader) => {
  return new DataLoader<string, boolean>(
    async (walletIds) => {
      const rows = await parent.prisma.orm.WalletKey.where((k) => k.walletId.in(uniq(walletIds)))
        .select('walletId')
        .all();
      const set = new Set(rows.map((r) => r.walletId));
      return walletIds.map((id) => set.has(id));
    },
    { ...parent.dataLoaderOptions }
  );
};

export const custodialWalletLoader = (parent: RootDataLoader) => {
  return new DataLoader<string, CustodialWalletRow | null>(
    async (ids) => {
      const rows = await parent.prisma.orm.CustodialWallet.where((w) => w.id.in(uniq(ids))).all();
      return indexBy(ids, rows, (w) => w.id);
    },
    { ...parent.dataLoaderOptions }
  );
};

export const virtualAccountLoader = (parent: RootDataLoader) => {
  return new DataLoader<string, VirtualAccountRow | null>(
    async (ids) => {
      const rows = await parent.prisma.orm.VirtualAccount.where((v) => v.id.in(uniq(ids))).all();
      return indexBy(ids, rows, (v) => v.id);
    },
    { ...parent.dataLoaderOptions }
  );
};

export const microdepositsForVirtualAccountLoader = (parent: RootDataLoader) => {
  return new DataLoader<string, MicrodepositRow[]>(
    async (virtualAccountIds) => {
      const rows = await parent.prisma.orm.Microdeposit.where((m) =>
        m.virtualAccountId.in(uniq(virtualAccountIds))
      )
        .orderBy((m) => m.occurredAt.desc())
        .all();
      return groupBy(virtualAccountIds, rows, (m) => m.virtualAccountId);
    },
    { ...parent.dataLoaderOptions }
  );
};

export const virtualAccountsForCustomerLoader = (parent: RootDataLoader) => {
  return new DataLoader<string, VirtualAccountRow[]>(
    async (customerIds) => {
      const rows = await parent.prisma.orm.VirtualAccount.where((v) =>
        v.customerId.in(uniq(customerIds))
      )
        .orderBy((v) => v.id.asc())
        .all();
      return groupBy(customerIds, rows, (v) => v.customerId);
    },
    { ...parent.dataLoaderOptions }
  );
};
