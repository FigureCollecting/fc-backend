/**
 * LEGACY GLUE TESTS — the Mongo user-id → Authentik-uuid lookup.
 *
 * THIS FILE DOES NOT PORT. It exists only for as long as fc-backend
 * authenticates with its own JWT over Mongo user documents; the Postgres-only
 * backend gets its Authentik subject from somewhere else and deletes both this
 * suite and src/services/entitlementSubject.legacy.ts with it.
 *
 * Everything that DOES port is tested without a database in
 * tests/services/entitlements/.
 */
import mongoose from 'mongoose';
import User from '../../src/models/User';
import { resolveEntitlementSubject } from '../../src/services/entitlementSubject.legacy';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('resolveEntitlementSubject', () => {
  const userId = new mongoose.Types.ObjectId('0000000000000000000004a2');

  const makeUser = async (authentikId?: string): Promise<void> => {
    await User.create({
      _id: userId,
      username: 'entitleduser',
      email: 'entitled@test.com',
      password: 'password123',
      ...(authentikId === undefined ? {} : { authentikId }),
    });
  };

  it('returns the Authentik uuid recorded on the user', async () => {
    await makeUser(SUB);
    await expect(resolveEntitlementSubject(userId.toString())).resolves.toBe(SUB);
  });

  it('returns null when the user has no Authentik identity yet', async () => {
    await makeUser();
    await expect(resolveEntitlementSubject(userId.toString())).resolves.toBeNull();
  });

  it('refuses a subject that is not a uuid — OpenFGA stores it verbatim and a typo grants nobody', async () => {
    await makeUser('ross@example.com');
    await expect(resolveEntitlementSubject(userId.toString())).resolves.toBeNull();
  });

  it('returns null for an unknown user id', async () => {
    await expect(resolveEntitlementSubject(new mongoose.Types.ObjectId().toString())).resolves.toBeNull();
  });

  it('returns null for a malformed user id rather than throwing', async () => {
    await expect(resolveEntitlementSubject('not-an-object-id')).resolves.toBeNull();
  });

  it('returns null when the lookup itself fails — a sick database denies, it does not 500', async () => {
    const boom = jest.spyOn(User, 'findById').mockImplementation(() => {
      throw new Error('connection pool destroyed');
    });
    try {
      await expect(resolveEntitlementSubject(userId.toString())).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      boom.mockRestore();
    }
  });
});
