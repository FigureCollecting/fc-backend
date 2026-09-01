import mongoose from 'mongoose';
import Company, { ICompany, ICompanyData, CompanyCategory } from '../../src/models/Company';
import RoleType, { seedRoleTypes } from '../../src/models/RoleType';

describe('Company Model', () => {
  let manufacturerRoleId: mongoose.Types.ObjectId;
  let distributorRoleId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    // Seed role types to get valid role IDs for testing
    await seedRoleTypes();
    const manufacturer = await RoleType.findOne({ name: 'Manufacturer', kind: 'company' });
    const distributor = await RoleType.findOne({ name: 'Distributor', kind: 'company' });
    manufacturerRoleId = manufacturer!._id;
    distributorRoleId = distributor!._id;
  });

  describe('Schema Validation', () => {
    it('should create a company with all required fields', async () => {
      const companyData: Partial<ICompanyData> = {
        name: 'Good Smile Company',
        category: 'company',
        subType: manufacturerRoleId
      };

      const company = await Company.create(companyData);

      expect(company.name).toBe('Good Smile Company');
      expect(company.category).toBe('company');
      expect(company.subType.toString()).toBe(manufacturerRoleId.toString());
      expect(company._id).toBeDefined();
    });

    it('should create a company with optional mfcId', async () => {
      const companyData: Partial<ICompanyData> = {
        name: 'Alter',
        category: 'company',
        subType: manufacturerRoleId,
        mfcId: 12345
      };

      const company = await Company.create(companyData);

      expect(company.mfcId).toBe(12345);
    });

    it('should require name field', async () => {
      const companyData = {
        category: 'company' as const,
        subType: manufacturerRoleId
      };

      await expect(Company.create(companyData)).rejects.toThrow();
    });

    it('should require category field', async () => {
      const companyData = {
        name: 'Test Company',
        subType: manufacturerRoleId
      };

      await expect(Company.create(companyData)).rejects.toThrow();
    });

    it('should require subType field', async () => {
      const companyData = {
        name: 'Test Company',
        category: 'company' as const
      };

      await expect(Company.create(companyData)).rejects.toThrow();
    });

    it('should only accept valid category values', async () => {
      const companyData = {
        name: 'Test Company',
        category: 'invalid_category',
        subType: manufacturerRoleId
      };

      await expect(Company.create(companyData as any)).rejects.toThrow();
    });

    it('should enforce unique name+category+subType combination', async () => {
      const companyData: Partial<ICompanyData> = {
        name: 'UniqueTestCompany',
        category: 'company',
        subType: manufacturerRoleId
      };

      await Company.create(companyData);
      await expect(Company.create(companyData)).rejects.toThrow();
    });

    it('should allow same name with different subType', async () => {
      const companyName = 'MultiRoleCompany';

      const asManufacturer = await Company.create({
        name: companyName,
        category: 'company',
        subType: manufacturerRoleId
      });

      const asDistributor = await Company.create({
        name: companyName,
        category: 'company',
        subType: distributorRoleId
      });

      expect(asManufacturer.name).toBe(companyName);
      expect(asDistributor.name).toBe(companyName);
      expect(asManufacturer._id.toString()).not.toBe(asDistributor._id.toString());
    });

    it('should allow same name with different category', async () => {
      await Company.create({
        name: 'SameNameDifferentCategory',
        category: 'company',
        subType: manufacturerRoleId
      });

      const personEntry = await Company.create({
        name: 'SameNameDifferentCategory',
        category: 'person',
        subType: manufacturerRoleId
      });

      expect(personEntry.name).toBe('SameNameDifferentCategory');
      expect(personEntry.category).toBe('person');
    });

    it('should accept person category', async () => {
      const companyData: Partial<ICompanyData> = {
        name: 'John Doe Manufacturing',
        category: 'person',
        subType: manufacturerRoleId
      };

      const company = await Company.create(companyData);

      expect(company.category).toBe('person');
    });
  });

  describe('CompanyCategory enum', () => {
    it('should have company and person categories', () => {
      expect(CompanyCategory.COMPANY).toBe('company');
      expect(CompanyCategory.PERSON).toBe('person');
    });
  });

  describe('RoleType Reference', () => {
    it('should populate subType reference', async () => {
      // Re-seed RoleTypes since afterEach clears all collections
      await seedRoleTypes();
      // Get fresh reference after seeding
      const freshManufacturer = await RoleType.findOne({ name: 'Manufacturer', kind: 'company' });

      const company = await Company.create({
        name: 'PopulateTestCompany',
        category: 'company',
        subType: freshManufacturer!._id
      });

      const populated = await Company.findById(company._id).populate('subType');

      expect(populated?.subType).toBeDefined();
      expect((populated?.subType as any).name).toBe('Manufacturer');
      expect((populated?.subType as any).kind).toBe('company');
    });
  });

  describe('Query Operations', () => {
    beforeEach(async () => {
      // Create test companies
      await Company.create([
        { name: 'QueryTest Alpha', category: 'company', subType: manufacturerRoleId },
        { name: 'QueryTest Beta', category: 'company', subType: distributorRoleId },
        { name: 'QueryTest Gamma', category: 'person', subType: manufacturerRoleId }
      ]);
    });

    it('should find companies by category', async () => {
      const companies = await Company.find({ category: 'company', name: /^QueryTest/ });
      expect(companies.length).toBe(2);
      companies.forEach((c: ICompany) => {
        expect(c.category).toBe('company');
      });
    });

    it('should find companies by subType', async () => {
      const manufacturers = await Company.find({
        subType: manufacturerRoleId,
        name: /^QueryTest/
      });
      expect(manufacturers.length).toBe(2);
    });

    it('should find companies by name pattern', async () => {
      const companies = await Company.find({ name: /^QueryTest/ });
      expect(companies.length).toBe(3);
    });

    it('should support sorting by name', async () => {
      const companies = await Company.find({ name: /^QueryTest/ }).sort({ name: 1 });
      expect(companies[0].name).toBe('QueryTest Alpha');
      expect(companies[1].name).toBe('QueryTest Beta');
      expect(companies[2].name).toBe('QueryTest Gamma');
    });
  });

  describe('mfcId Operations', () => {
    it('should find company by mfcId', async () => {
      await Company.create({
        name: 'MFC Lookup Test',
        category: 'company',
        subType: manufacturerRoleId,
        mfcId: 99999
      });

      const found = await Company.findOne({ mfcId: 99999 });
      expect(found?.name).toBe('MFC Lookup Test');
    });

    it('should allow multiple companies without mfcId', async () => {
      await Company.create({
        name: 'No MFC ID 1',
        category: 'company',
        subType: manufacturerRoleId
      });

      const second = await Company.create({
        name: 'No MFC ID 2',
        category: 'company',
        subType: distributorRoleId
      });

      expect(second.mfcId).toBeUndefined();
    });
  });

  describe('Timestamps', () => {
    it('should automatically set createdAt and updatedAt', async () => {
      const company = await Company.create({
        name: 'Timestamp Test Company',
        category: 'company',
        subType: manufacturerRoleId
      });

      expect(company.createdAt).toBeDefined();
      expect(company.updatedAt).toBeDefined();
      expect(company.createdAt).toBeInstanceOf(Date);
    });

    it('should update updatedAt on save', async () => {
      const company = await Company.create({
        name: 'Update Test Company',
        category: 'company',
        subType: manufacturerRoleId
      });
      const originalUpdatedAt = company.updatedAt;

      await new Promise(resolve => setTimeout(resolve, 10));

      company.name = 'Updated Company Name';
      await company.save();

      expect(company.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });
  });
});
