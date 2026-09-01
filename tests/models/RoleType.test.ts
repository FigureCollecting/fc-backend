import RoleType, { IRoleType, IRoleTypeData, RoleKind, seedRoleTypes, SYSTEM_ROLES } from '../../src/models/RoleType';

describe('RoleType Model', () => {
  describe('Schema Validation', () => {
    it('should create a role type with all required fields', async () => {
      const roleData: Partial<IRoleTypeData> = {
        name: 'Manufacturer',
        kind: 'company',
        displayOrder: 1,
        isSystem: true
      };

      const role = await RoleType.create(roleData);

      expect(role.name).toBe('Manufacturer');
      expect(role.kind).toBe('company');
      expect(role.displayOrder).toBe(1);
      expect(role.isSystem).toBe(true);
      expect(role._id).toBeDefined();
    });

    it('should create a role type with optional mfcName', async () => {
      const roleData: Partial<IRoleTypeData> = {
        name: 'Illustrator',
        kind: 'artist',
        mfcName: 'Original Illustrator',
        displayOrder: 1,
        isSystem: true
      };

      const role = await RoleType.create(roleData);

      expect(role.mfcName).toBe('Original Illustrator');
    });

    it('should require name field', async () => {
      const roleData = {
        kind: 'company' as const,
        displayOrder: 1,
        isSystem: true
      };

      await expect(RoleType.create(roleData)).rejects.toThrow();
    });

    it('should require kind field', async () => {
      const roleData = {
        name: 'Manufacturer',
        displayOrder: 1,
        isSystem: true
      };

      await expect(RoleType.create(roleData)).rejects.toThrow();
    });

    it('should only accept valid kind values', async () => {
      const roleData = {
        name: 'Invalid',
        kind: 'invalid_kind',
        displayOrder: 1,
        isSystem: true
      };

      await expect(RoleType.create(roleData as any)).rejects.toThrow();
    });

    it('should enforce unique name+kind combination', async () => {
      const roleData: Partial<IRoleTypeData> = {
        name: 'TestManufacturer',
        kind: 'company',
        displayOrder: 1,
        isSystem: true
      };

      await RoleType.create(roleData);
      await expect(RoleType.create(roleData)).rejects.toThrow();
    });

    it('should allow same name with different kind', async () => {
      await RoleType.create({
        name: 'TestDesigner',
        kind: 'company',
        displayOrder: 1,
        isSystem: true
      });

      const artistDesigner = await RoleType.create({
        name: 'TestDesigner',
        kind: 'artist',
        displayOrder: 1,
        isSystem: true
      });

      expect(artistDesigner.name).toBe('TestDesigner');
      expect(artistDesigner.kind).toBe('artist');
    });

    it('should default isSystem to false', async () => {
      const role = await RoleType.create({
        name: 'Custom Role',
        kind: 'company',
        displayOrder: 100
      });

      expect(role.isSystem).toBe(false);
    });
  });

  describe('RoleKind enum', () => {
    it('should have company, artist, and relation kinds', () => {
      expect(RoleKind.COMPANY).toBe('company');
      expect(RoleKind.ARTIST).toBe('artist');
      expect(RoleKind.RELATION).toBe('relation');
    });
  });

  describe('SYSTEM_ROLES constant', () => {
    it('should define company roles', () => {
      const companyRoles = SYSTEM_ROLES.filter((r: IRoleTypeData) => r.kind === 'company');
      expect(companyRoles.map((r: IRoleTypeData) => r.name)).toContain('Manufacturer');
      expect(companyRoles.map((r: IRoleTypeData) => r.name)).toContain('Distributor');
      expect(companyRoles.map((r: IRoleTypeData) => r.name)).toContain('Retailer');
    });

    it('should define artist roles', () => {
      const artistRoles = SYSTEM_ROLES.filter((r: IRoleTypeData) => r.kind === 'artist');
      expect(artistRoles.map((r: IRoleTypeData) => r.name)).toContain('Illustrator');
      expect(artistRoles.map((r: IRoleTypeData) => r.name)).toContain('Sculptor');
      expect(artistRoles.map((r: IRoleTypeData) => r.name)).toContain('Painter');
      expect(artistRoles.map((r: IRoleTypeData) => r.name)).toContain('Designer');
    });

    it('should define relation types', () => {
      const relationTypes = SYSTEM_ROLES.filter((r: IRoleTypeData) => r.kind === 'relation');
      expect(relationTypes.map((r: IRoleTypeData) => r.name)).toContain('Variant');
      expect(relationTypes.map((r: IRoleTypeData) => r.name)).toContain('Reissue');
      expect(relationTypes.map((r: IRoleTypeData) => r.name)).toContain('Limited Edition');
      expect(relationTypes.map((r: IRoleTypeData) => r.name)).toContain('Bundle');
    });

    it('should have all roles marked as system roles', () => {
      SYSTEM_ROLES.forEach((role: IRoleTypeData) => {
        expect(role.isSystem).toBe(true);
      });
    });
  });

  describe('seedRoleTypes function', () => {
    it('should seed all system roles when database is empty', async () => {
      await seedRoleTypes();

      const allRoles = await RoleType.find({});
      expect(allRoles.length).toBe(SYSTEM_ROLES.length);
    });

    it('should not duplicate roles when called multiple times', async () => {
      await seedRoleTypes();
      await seedRoleTypes();

      const allRoles = await RoleType.find({});
      expect(allRoles.length).toBe(SYSTEM_ROLES.length);
    });

    it('should preserve existing system roles', async () => {
      await seedRoleTypes();

      const manufacturer = await RoleType.findOne({ name: 'Manufacturer', kind: 'company' });
      const originalId = manufacturer?._id;

      await seedRoleTypes();

      const manufacturerAfter = await RoleType.findOne({ name: 'Manufacturer', kind: 'company' });
      expect(manufacturerAfter?._id.toString()).toBe(originalId?.toString());
    });

    it('should return count of seeded roles', async () => {
      const result = await seedRoleTypes();
      expect(result.seeded).toBe(SYSTEM_ROLES.length);
      expect(result.skipped).toBe(0);

      const result2 = await seedRoleTypes();
      expect(result2.seeded).toBe(0);
      expect(result2.skipped).toBe(SYSTEM_ROLES.length);
    });
  });

  describe('Query helpers', () => {
    beforeEach(async () => {
      await seedRoleTypes();
    });

    it('should find roles by kind', async () => {
      const companyRoles = await RoleType.find({ kind: 'company' }).sort({ displayOrder: 1 });
      expect(companyRoles.length).toBeGreaterThan(0);
      companyRoles.forEach(role => {
        expect(role.kind).toBe('company');
      });
    });

    it('should find roles by name pattern', async () => {
      const roles = await RoleType.find({ name: /^M/ });
      expect(roles.length).toBeGreaterThan(0);
      roles.forEach(role => {
        expect(role.name.startsWith('M')).toBe(true);
      });
    });

    it('should order roles by displayOrder', async () => {
      const artistRoles = await RoleType.find({ kind: 'artist' }).sort({ displayOrder: 1 });
      for (let i = 1; i < artistRoles.length; i++) {
        expect(artistRoles[i].displayOrder).toBeGreaterThanOrEqual(artistRoles[i - 1].displayOrder);
      }
    });
  });
});
