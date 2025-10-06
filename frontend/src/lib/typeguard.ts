// src/lib/typeguard.ts
// A simple type guard to check if a value is an object (and not null or an array)

import { z } from "zod";

export const AppConfigSchema = z.object({
    python_path: z.string().min(1, "Python path cannot be empty"),
    arc_path: z.string().min(1, "ARC.py path cannot be empty"),
    default_work_dir: z.string().min(1, "Default work dir cannot be empty"),
    concurrency_cap: z.number().min(1, "Concurrency cap must be at least 1").max(64, "Concurrency cap cannot exceed 64"),
    tmux_path: z.string().optional().default(""),
});

// Infer the TypeScript type from the Zod schema
export type AppConfig = z.infer<typeof AppConfigSchema>;
