// Roles, memberships and the permission matrix. Roles attach to a room membership, not
// the global identity, so the same person can be admin in one room and guest in another.
// An agent is a first-class member with its own did:key. See DESIGN.md sec 6.

export type Role = "owner" | "admin" | "member" | "agent" | "guest";

export interface Membership {
  did: string;
  displayName: string;
  kind: "human" | "agent";
  role: Role;
  joinedAt: string;
  /** for agent members, the bridge this agent is reached through. */
  bridgeId?: string;
}

export type Capability =
  | "post"
  | "fork"
  | "manageMembers"
  | "manageBridges"
  | "approveTool"
  | "manageRoom";

const MATRIX: Record<Capability, readonly Role[]> = {
  post: ["owner", "admin", "member", "agent", "guest"],
  fork: ["owner", "admin", "member", "agent"],
  manageMembers: ["owner", "admin"],
  manageBridges: ["owner", "admin"],
  // an agent never approves a gated tool call, a human authorizes it
  approveTool: ["owner", "admin", "member"],
  manageRoom: ["owner", "admin"],
};

export function can(role: Role, cap: Capability): boolean {
  return MATRIX[cap].includes(role);
}

/** Delete rule is special: owners and admins delete anything, everyone else own only. */
export function canDelete(role: Role, isOwnNode: boolean): boolean {
  return role === "owner" || role === "admin" || isOwnNode;
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  agent: "Agent",
  guest: "Guest",
};
