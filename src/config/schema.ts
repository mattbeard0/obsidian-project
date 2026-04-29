import { z } from 'zod';

export const folderStructureSchema = z.object({
  raw: z.string().min(1).default('raw'),
  wiki: z.string().min(1).default('wiki'),
  output: z.string().min(1).default('output'),
  projectWiki: z.string().min(1).default('project'),
  commonWiki: z.string().min(1).default('common')
});

export const appConfigSchema = z.object({
  version: z.literal(1).default(1),
  vaultRoot: z.string().min(1),
  repoPrefix: z.string().min(1).default('obsidian-vault-'),
  commonProjectName: z.string().min(1).default('common'),
  commonConfigured: z.boolean().default(true),
  commonVaultPath: z.string().min(1).optional(),
  folderStructure: folderStructureSchema.default({
    raw: 'raw',
    wiki: 'wiki',
    output: 'output',
    projectWiki: 'project',
    commonWiki: 'common'
  }),
  copyFromCommon: z.array(z.string()).default([]),
  github: z
    .object({
      owner: z.string().optional(),
      visibility: z.enum(['private', 'public', 'internal']).default('private'),
      createRemotes: z.boolean().default(false)
    })
    .default({
      visibility: 'private',
      createRemotes: false
    }),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      preferredPort: z.number().int().min(1024).max(65535).default(57891),
      maxPortScan: z.number().int().min(1).max(5000).default(1000)
    })
    .default({
      host: '127.0.0.1',
      preferredPort: 57891,
      maxPortScan: 1000
    }),
  codex: z
    .object({
      configPath: z.string().optional(),
      mcpServerNamePrefix: z.string().min(1).default('obsidianProject'),
      profileNamePrefix: z.string().min(1).default('obsidian-vault-')
    })
    .default({
      mcpServerNamePrefix: 'obsidianProject',
      profileNamePrefix: 'obsidian-vault-'
    })
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type FolderStructure = z.infer<typeof folderStructureSchema>;
