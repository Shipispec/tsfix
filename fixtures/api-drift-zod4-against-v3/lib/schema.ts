// LLM trained on Zod 4 docs writes z.email() and z.uuid() as top-level
// helpers. Against zod@3 (installed in _shared) those properties don't
// exist on `typeof z` — TS2339 with no did-you-mean. v3 needs
// z.string().email(), z.string().uuid().

import { z } from "zod";

export const emailSchema = z.email();

export const idSchema = z.uuid();
