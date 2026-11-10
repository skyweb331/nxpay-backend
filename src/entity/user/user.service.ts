import { Service } from 'typedi';

import { PrismaService, type UserRow } from '#src/service/prisma.js';
import { UserRole } from '#src/graphql/enum.js';

import type { UserQueryArgs } from './user.type.js';

const USER_LIST = {
  model: 'User',
  filterable: [
    'id',
    'email',
    'name',
    'role',
    'isEmailVerified',
    'totpEnabled',
    'deletedAt',
    'createdAt',
  ],
  sortable: ['id', 'email', 'name', 'role', 'createdAt', 'lastLoginAt'],
  defaultSort: 'createdAt',
} as const;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

@Service()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /** Staff accounts (Admin / Support); customers are listed through `customers`. */
  private staffCollection() {
    return this.prisma.orm.User.where((u) => u.role.in([UserRole.Admin, UserRole.Support]));
  }

  async getStaffUsers(query: UserQueryArgs): Promise<UserRow[]> {
    return query.applyTo(this.staffCollection(), USER_LIST).all();
  }

  async getStaffUsersCount(query: UserQueryArgs): Promise<number> {
    const { total } = await query
      .applyFilter(this.staffCollection(), USER_LIST)
      .aggregate((a) => ({ total: a.count() }));
    return Number(total);
  }

  async getUserById(id: string) {
    return this.prisma.orm.User.where({ id }).first();
  }

  async getUserByEmail(email: string) {
    return this.prisma.orm.User.where({ email: normalizeEmail(email) }).first();
  }

  async createUser(data: {
    email: string;
    password: string;
    name: string;
    role: UserRole;
    isEmailVerified?: boolean;
    approvedAt?: Date | null;
  }) {
    return this.prisma.orm.User.create({
      ...data,
      email: normalizeEmail(data.email),
      isEmailVerified: data.isEmailVerified ?? false,
    });
  }

  async updateUser(
    id: string,
    data: Partial<
      Pick<
        UserRow,
        | 'name'
        | 'email'
        | 'password'
        | 'role'
        | 'isEmailVerified'
        | 'totpSecret'
        | 'totpEnabled'
        | 'totpBackupCodes'
        | 'approvedAt'
        | 'lastLoginAt'
        | 'deletedAt'
      >
    >
  ) {
    const user = await this.prisma.orm.User.where({ id }).update(data);
    if (!user) throw new Error(`User ${id} not found`);
    return user;
  }
}
