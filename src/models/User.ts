import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export type ColorProfile = 'light' | 'dark' | 'terminal' | 'surprise';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  username: string;
  email: string;
  password: string;
  isAdmin: boolean;
  /** Authentik user uuid, when this account is linked to one. See below. */
  authentikId?: string;
  colorProfile: ColorProfile;
  emailVerified: boolean;
  emailVerifiedAt?: Date;
  emailVerificationGraceExpiry?: Date;
  twoFactorEnabled: boolean;
  totp?: {
    secret: string;
    verified: boolean;
  };
  backupCodes?: string[];
  webauthnCredentials: Array<{
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports?: string[];
    nickname?: string;
    createdAt: Date;
  }>;
  comparePassword(candidatePassword: string): Promise<boolean>;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    username: { 
      type: String, 
      required: true, 
      unique: true 
    },
    email: { 
      type: String, 
      required: true, 
      unique: true 
    },
    password: { 
      type: String, 
      required: true 
    },
    isAdmin: {
      type: Boolean,
      default: false
    },
    // The Authentik user uuid this account maps to. OPTIONAL and absent on
    // almost every document: fc-backend still authenticates with its own JWT
    // over Mongo users, while the estate's authorization graph (OpenFGA, on the
    // auth cluster) keys every subject by Authentik uuid.
    //
    // It is the JOIN between the two, and the only way an entitlement Check can
    // be run for a logged-in user (src/services/entitlementGrants.ts). Absent
    // means no subject means DENY, which is the correct default for everyone
    // until Authentik becomes this service's login at the k3s cutover.
    //
    // sparse+unique: documents without the field are not indexed, but two users
    // must never claim ONE Authentik identity — that would hand a second
    // account somebody else's grants.
    authentikId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true
    },
    colorProfile: {
      type: String,
      enum: ['light', 'dark', 'terminal', 'surprise'],
      default: 'light'
    },
    emailVerified: {
      type: Boolean,
      default: false
    },
    emailVerifiedAt: {
      type: Date
    },
    emailVerificationGraceExpiry: {
      type: Date
    },
    twoFactorEnabled: {
      type: Boolean,
      default: false
    },
    totp: {
      secret: { type: String, select: false },
      verified: { type: Boolean, default: false }
    },
    backupCodes: {
      type: [String],
      select: false
    },
    webauthnCredentials: [{
      credentialId: { type: String, required: true },
      publicKey: { type: String, required: true, select: false },
      signCount: { type: Number, default: 0 },
      transports: [String],
      nickname: { type: String, maxlength: 50 },
      createdAt: { type: Date, default: Date.now }
    }]
  },
  { timestamps: true }
);

// Hash password before saving
UserSchema.pre('save', async function() {
  if (!this.isModified('password')) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to compare passwords
UserSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
  return await bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model<IUser>('User', UserSchema);
