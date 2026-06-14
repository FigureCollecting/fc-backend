import mongoose, { Document, Schema } from 'mongoose';

/**
 * Schema v3.0 - Enhanced Figure Model
 *
 * This model combines both catalog data and user-specific data in a single document
 * for backward compatibility. The full v3.0 architecture splits these into:
 * - MFCItem: Shared catalog data (from MFC)
 * - UserFigure: User-specific data (ownership, purchase info, ratings)
 *
 * This unified model supports the existing API while allowing gradual migration.
 */

// Subdocument interfaces
export interface IRelease {
  date?: Date;
  price?: number;
  currency?: string;
  isRerelease?: boolean;
  jan?: string;
  variant?: string;  // Release variant (e.g., "Standard (Japan)", "Limited (China)")
}

export interface IDimensions {
  heightMm?: number;
  widthMm?: number;
  depthMm?: number;
  scaledHeight?: string;
}

export interface IPurchaseInfo {
  date?: Date;
  price?: number;
  currency?: string;
  source?: string;
}

export interface IMerchant {
  name?: string;
  url?: string;
}

export interface ICompanyRole {
  companyId?: mongoose.Types.ObjectId;
  companyName?: string;
  roleId?: mongoose.Types.ObjectId;
  roleName?: string;
}

export interface IArtistRole {
  artistId?: mongoose.Types.ObjectId;
  artistName?: string;
  roleId?: mongoose.Types.ObjectId;
  roleName?: string;
}

export interface IFigure extends Document {
  _id: mongoose.Types.ObjectId;

  // Core identification
  manufacturer: string;
  name: string;
  scale?: string;
  mfcLink?: string;
  mfcId?: number;
  jan?: string;

  // MFC-specific fields (Schema v3)
  mfcTitle?: string;        // The figure's specific title from MFC
  origin?: string;          // Series/franchise (e.g., "Original", "Fate/Grand Order")
  version?: string;         // Variant info (e.g., "Little Devil Ver.")
  category?: string;        // Figure category (e.g., "Scale Figure")
  classification?: string;  // Classification (e.g., "Goods")
  materials?: string;       // Materials (e.g., "PVC, ABS")

  // Media
  imageUrl?: string;
  imageUrls?: string[];

  // Releases (supports multiple releases/rereleases)
  releases?: IRelease[];

  // Physical dimensions
  dimensions?: IDimensions;

  // Company/Artist roles (multivalue)
  companyRoles?: ICompanyRole[];
  artistRoles?: IArtistRole[];

  // User-specific collection data
  userId: mongoose.Types.ObjectId;
  collectionStatus?: 'owned' | 'ordered' | 'wished';
  mfcActivityOrder?: number;
  quantity?: number;
  rating?: number;
  wishRating?: number;
  note?: string;

  // Purchase information
  purchaseInfo?: IPurchaseInfo;
  merchant?: IMerchant;

  // Condition tracking
  figureCondition?: 'sealed' | 'likenew' | 'verygood' | 'good' | 'fair' | 'poor';
  figureConditionNotes?: string;
  boxCondition?: 'mint' | 'verygood' | 'good' | 'fair' | 'poor';
  boxConditionNotes?: string;

  // Tags and metadata
  tags?: string[];

  // Legacy fields
  type?: string;
  description?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

// Subdocument schemas
const ReleaseSchema = new Schema<IRelease>(
  {
    date: { type: Date },
    price: { type: Number },
    currency: { type: String, default: 'JPY' },
    isRerelease: { type: Boolean, default: false },
    jan: { type: String },
    variant: { type: String }  // Release variant (e.g., "Standard (Japan)", "Limited (China)")
  },
  { _id: false }
);

const DimensionsSchema = new Schema<IDimensions>(
  {
    heightMm: { type: Number },
    widthMm: { type: Number },
    depthMm: { type: Number },
    scaledHeight: { type: String }
  },
  { _id: false }
);

const PurchaseInfoSchema = new Schema<IPurchaseInfo>(
  {
    date: { type: Date },
    price: { type: Number },
    currency: { type: String, default: 'USD' },
    source: { type: String }
  },
  { _id: false }
);

const MerchantSchema = new Schema<IMerchant>(
  {
    name: { type: String },
    url: { type: String }
  },
  { _id: false }
);

const CompanyRoleSchema = new Schema<ICompanyRole>(
  {
    companyId: { type: Schema.Types.ObjectId, ref: 'Company' },
    companyName: { type: String },
    roleId: { type: Schema.Types.ObjectId, ref: 'RoleType' },
    roleName: { type: String }
  },
  { _id: false }
);

const ArtistRoleSchema = new Schema<IArtistRole>(
  {
    artistId: { type: Schema.Types.ObjectId, ref: 'Artist' },
    artistName: { type: String },
    roleId: { type: Schema.Types.ObjectId, ref: 'RoleType' },
    roleName: { type: String }
  },
  { _id: false }
);

const FigureSchema = new Schema<IFigure>(
  {
    // Core identification
    // Schema v3: manufacturer optional when companyRoles present (derived in pre-save)
    manufacturer: { type: String, index: true },
    name: { type: String, required: true, index: true },
    scale: { type: String },
    mfcLink: { type: String },
    mfcId: { type: Number, sparse: true, index: true },
    jan: { type: String },

    // MFC-specific fields (Schema v3)
    mfcTitle: { type: String },        // The figure's specific title from MFC
    origin: { type: String },          // Series/franchise
    version: { type: String },         // Variant info
    category: { type: String },        // Figure category
    classification: { type: String },  // Classification
    materials: { type: String },       // Materials

    // Media
    imageUrl: { type: String },
    imageUrls: { type: [String], default: [] },

    // Releases
    releases: { type: [ReleaseSchema], default: [] },

    // Dimensions
    dimensions: { type: DimensionsSchema },

    // Company/Artist roles
    companyRoles: { type: [CompanyRoleSchema], default: [] },
    artistRoles: { type: [ArtistRoleSchema], default: [] },

    // User ownership
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    collectionStatus: {
      type: String,
      enum: ['owned', 'ordered', 'wished'],
      default: 'owned'
    },
    mfcActivityOrder: { type: Number },
    quantity: { type: Number, default: 1, min: 1 },
    rating: { type: Number, min: 1, max: 10 },
    wishRating: { type: Number, min: 1, max: 5 },
    note: { type: String },

    // Purchase info
    purchaseInfo: { type: PurchaseInfoSchema },
    merchant: { type: MerchantSchema },

    // Condition
    figureCondition: {
      type: String,
      enum: ['sealed', 'likenew', 'verygood', 'good', 'fair', 'poor']
    },
    figureConditionNotes: { type: String },
    boxCondition: {
      type: String,
      enum: ['mint', 'verygood', 'good', 'fair', 'poor']
    },
    boxConditionNotes: { type: String },

    // Tags
    tags: { type: [String], default: [], index: true },

    // Legacy
    type: { type: String, default: 'action figure' },
    description: { type: String }
  },
  { timestamps: true }
);

// Indexes for performance
FigureSchema.index({ manufacturer: 1, name: 1 });
FigureSchema.index({ userId: 1, collectionStatus: 1 });
FigureSchema.index({ userId: 1, collectionStatus: 1, mfcActivityOrder: 1 });
FigureSchema.index({ userId: 1, rating: -1 });

// Text index for search
FigureSchema.index({ name: 'text', manufacturer: 'text', tags: 'text' });

// Schema v3: Derive manufacturer from companyRoles if not provided
FigureSchema.pre('save', function () {
  // If manufacturer is not set but we have companyRoles, derive it
  if (!this.manufacturer && this.companyRoles && this.companyRoles.length > 0) {
    // Find the first company with 'Manufacturer' role, or just use first company
    const manufacturerRole = this.companyRoles.find(
      (cr) => cr.roleName?.toLowerCase() === 'manufacturer'
    );
    const derivedManufacturer = manufacturerRole?.companyName || this.companyRoles[0].companyName;
    if (derivedManufacturer) {
      this.manufacturer = derivedManufacturer;
    }
  }
});

export default mongoose.model<IFigure>('Figure', FigureSchema);
