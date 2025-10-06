import { z} from "zod";

export const SettingsSchema = z.object({
    sshHost: z.string().min(1, "SSH Host is required"),
    sshPort: z.number().min(1).max(65535).default(22),
    sshUser: z.string().min(1, "SSH User is required"),
    privateKeyPath: z.string().optional(),
    keyPassphrase: z.string().optional(), // Should encrypt in a real app
    arcPath: z.string().min(1, "Required"), 
    pythonPath: z.string().min(1, "Required"),
    defaultQueue: z.string().default("default").optional(),
    maxConcurrentRuns: z.number().min(1).max(100).default(1),
    defaultWorkDir: z.string().default("/home/username/arc_runs").optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;