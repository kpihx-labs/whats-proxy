/**
 * whats-proxy — Action registry.
 *
 * Aggregates all 69 actions from the category modules into a single
 * kebab-case → definition map. Duplicate names are a hard error.
 */

import type { ActionDef, ActionRegistry } from "./types.ts";
import { policyFor, protectAction } from "./policies.ts";

import messaging from "./messaging.ts";
import chats from "./chats.ts";
import contacts from "./contacts.ts";
import groups from "./groups.ts";
import profile from "./profile.ts";
import overview from "./overview.ts";
import tags from "./tags.ts";
import utils from "./utils.ts";
import stories from "./stories.ts";
import communities from "./communities.ts";
import raw from "./raw.ts";

const ALL: ActionDef[] = [
  ...messaging, // 15
  ...chats,     // 5
  ...contacts,  // 6
  ...groups,    // 10
  ...profile,   // 4
  ...overview,  // 2
  ...tags,      // 1
  ...utils,     // 7
  ...stories,   // 3
  ...communities, // 13
  ...raw, // 1
];

export const REGISTRY: ActionRegistry = {};
for (const def of ALL) {
  if (REGISTRY[def.meta.action]) {
    throw new Error(`Duplicate action: ${def.meta.action}`);
  }
  REGISTRY[def.meta.action] = protectAction(def, policyFor(def.meta.action, def));
}

export const ACTION_COUNT = ALL.length;

export { ALL };
