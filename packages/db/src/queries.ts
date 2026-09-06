import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./client.ts";
import type { SessionArtifactKind, SessionArtifactRef } from "./artifacts.ts";
import type { CampaignAccessRole, CampaignMemberRole, SessionStatus } from "./domain.ts";
import { campaigns, campaignMembers, sessionArtifacts, sessions, users } from "./schema.ts";

export async function getCampaignsForGuild(guildId: string) {
  return db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(eq(campaigns.guildId, guildId))
    .orderBy(campaigns.name);
}

export async function getCampaignsForUser(userId: string) {
  if (await isAdmin(userId)) {
    return db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        role: sql<CampaignAccessRole>`'admin'`,
      })
      .from(campaigns)
      .orderBy(campaigns.name);
  }

  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      role: campaignMembers.role,
    })
    .from(campaignMembers)
    .innerJoin(campaigns, eq(campaignMembers.campaignId, campaigns.id))
    .where(eq(campaignMembers.userId, userId))
    .orderBy(campaigns.name);
}

export async function isAdmin(userId: string): Promise<boolean> {
  const [user] = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user?.isAdmin ?? false;
}

export interface CampaignAccess {
  isAdmin: boolean;
  isMember: boolean;
  canAccess: boolean;
}

export async function getCampaignAccess(
  campaignId: string,
  userId: string,
): Promise<CampaignAccess> {
  const [access] = await db
    .select({
      isAdmin: sql<boolean>`exists (
        select 1 from ${users}
        where ${users.id} = ${userId} and ${users.isAdmin} = true
      )`,
      isMember: sql<boolean>`exists (
        select 1 from ${campaignMembers}
        where ${campaignMembers.campaignId} = ${campaignId}
          and ${campaignMembers.userId} = ${userId}
      )`,
    })
    .from(sql`(select 1) as access_source`);
  const admin = access?.isAdmin ?? false;
  const member = access?.isMember ?? false;
  return { isAdmin: admin, isMember: member, canAccess: admin || member };
}

export interface CampaignMember {
  id: string;
  username: string;
  role: CampaignMemberRole;
  characterName: string | null;
}

// Lightweight lookup for command authorization: which guild owns the campaign
// and who is its DM. Returns null if the campaign does not exist.
export async function getCampaignMeta(
  campaignId: string,
): Promise<{ guildId: string; dmId: string | null } | null> {
  const [campaign] = await db
    .select({ guildId: campaigns.guildId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return null;

  const [dm] = await db
    .select({ userId: campaignMembers.userId })
    .from(campaignMembers)
    .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.role, "dm")))
    .limit(1);

  return { guildId: campaign.guildId, dmId: dm?.userId ?? null };
}

export interface CampaignCastMember {
  userId: string;
  username: string;
  characterName: string;
}

// The players of a campaign that have a character assigned, for building the
// transcript's cast legend. Keyed by userId so callers can align it with the
// speaker labels used in the transcript body.
export async function getCampaignCast(campaignId: string): Promise<CampaignCastMember[]> {
  const rows = await db
    .select({
      userId: users.id,
      username: users.username,
      characterName: campaignMembers.characterName,
    })
    .from(campaignMembers)
    .innerJoin(users, eq(campaignMembers.userId, users.id))
    .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.role, "player")))
    .orderBy(users.username);

  return rows.filter((r): r is CampaignCastMember => r.characterName !== null);
}

export interface CampaignSessionSummary {
  id: string;
  title: string | null;
  status: SessionStatus;
  startedAt: Date;
  endedAt: Date | null;
}

export interface CampaignDetail {
  id: string;
  name: string;
  description: string | null;
  members: CampaignMember[];
  sessions: CampaignSessionSummary[];
}

export async function getCampaignDetail(campaignId: string): Promise<CampaignDetail | null> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) return null;

  const members = await db
    .select({
      id: users.id,
      username: users.username,
      role: campaignMembers.role,
      characterName: campaignMembers.characterName,
    })
    .from(campaignMembers)
    .innerJoin(users, eq(campaignMembers.userId, users.id))
    .where(eq(campaignMembers.campaignId, campaignId));

  const sessionRows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
    })
    .from(sessions)
    .where(eq(sessions.campaignId, campaignId))
    .orderBy(desc(sessions.startedAt));

  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    members,
    sessions: sessionRows,
  };
}

export interface SessionDetail {
  id: string;
  campaignId: string;
  title: string | null;
  status: SessionStatus;
  startedAt: Date;
  endedAt: Date | null;
  transcriptArtifact: SessionArtifactRef | null;
  detailedRecordArtifact: SessionArtifactRef | null;
  recap: string | null;
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const [session] = await db
    .select({
      id: sessions.id,
      campaignId: sessions.campaignId,
      title: sessions.title,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      recap: sessions.recap,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) return null;

  const artifacts = await db
    .select()
    .from(sessionArtifacts)
    .where(and(eq(sessionArtifacts.sessionId, sessionId), eq(sessionArtifacts.isCurrent, true)));
  const toRef = (kind: SessionArtifactKind): SessionArtifactRef | null => {
    const artifact = artifacts.find((candidate) => candidate.kind === kind);
    return artifact
      ? {
          id: artifact.id,
          kind,
          bucket: artifact.bucket,
          objectKey: artifact.objectKey,
          contentType: artifact.contentType,
          formatVersion: artifact.formatVersion,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
        }
      : null;
  };
  const transcriptArtifact = toRef("transcript");
  const detailedRecordArtifact = toRef("detailed_record");

  return {
    ...session,
    transcriptArtifact,
    detailedRecordArtifact,
  };
}

export async function getSessionStatus(sessionId: string): Promise<SessionStatus | null> {
  const [session] = await db
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return session?.status ?? null;
}
