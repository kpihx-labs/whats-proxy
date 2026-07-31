/**
 * whats-proxy — Action registry.
 *
 * Aggregates all 65 actions from the category modules into a single
 * kebab-case → definition map. Duplicate names are a hard error.
 */

import type { ActionDef, ActionRegistry } from "./types.ts";

import messaging from "./messaging.ts";
import chats from "./chats.ts";
import contacts from "./contacts.ts";
import groups from "./groups.ts";
import channels from "./channels.ts";
import labels from "./labels.ts";
import profile from "./profile.ts";
import analytics from "./analytics.ts";
import overview from "./overview.ts";
import digest from "./digest.ts";
import tags from "./tags.ts";
import watchlists from "./watchlists.ts";
import utils from "./utils.ts";

const ALL: ActionDef[] = [
  ...messaging, // 14
  ...chats,     // 5
  ...contacts,  // 6
  ...groups,    // 10
  ...channels,  // 5
  ...labels,    // 3
  ...profile,   // 4
  ...analytics, // 5
  ...overview,  // 2
  ...digest,    // 2
  ...tags,      // 1
  ...watchlists,// 1
  ...utils,     // 7
];

export const REGISTRY: ActionRegistry = {};
for (const def of ALL) {
  if (REGISTRY[def.meta.action]) {
    throw new Error(`Duplicate action: ${def.meta.action}`);
  }
  REGISTRY[def.meta.action] = def;
}

export const ACTION_COUNT = ALL.length;

export { ALL };
