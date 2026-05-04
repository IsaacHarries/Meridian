/**
 * Thin assembly module for the Implement-a-Ticket Zustand store.
 *
 * The state shape lives in `./types`, the initial values in `./initial`,
 * and every action is built by a per-domain `createXxxActions(set, get)`
 * factory. This file just spreads them all together.
 */

import { create } from "zustand";

import { INITIAL } from "./initial";
import type { ImplementTicketState } from "./types";

import { createGroomingActions } from "./actions/grooming";
import { createImplementationActions } from "./actions/implementation";
import { createLifecycleActions } from "./actions/lifecycle";
import { createOrchestratorActions } from "./actions/orchestrator";
import { createTriageActions } from "./actions/triage";

export const useImplementTicketStore = create<ImplementTicketState>()(
  (set, get) => ({
    ...INITIAL,
    ...createLifecycleActions(set, get),
    ...createGroomingActions(set, get),
    ...createTriageActions(set, get),
    ...createImplementationActions(set, get),
    ...createOrchestratorActions(set, get),
  }),
);
