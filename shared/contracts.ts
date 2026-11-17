import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const cpaSettings = defineSettings({
  id: "cpa",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Providers hidden from Usage. New providers in the CPA pool show by default. */
    disabledProviders: z.array(z.string()).default([]),
    /** Minimum minutes between upstream quota calls per account. 0 = Paseo's own 5-minute cache only. */
    refreshMinutes: z.number().int().min(0).max(1440).default(0),
  }),
});

export const statusRpc = defineRpc({
  name: "cpa.status",
  input: z.object({ probe: z.boolean() }),
  output: z.object({
    connected: z.boolean(),
    baseUrl: z.string().optional(),
    via: z.string().optional(),
    error: z.string().optional(),
    providers: z.array(
      z.object({ id: z.string(), accounts: z.number(), supported: z.boolean() }),
    ),
    probe: z.string().optional(),
  }),
});
