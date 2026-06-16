import { defineConfig, defineDocs, frontmatterSchema, metaSchema } from 'fumadocs-mdx/config';
import { z } from 'zod';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: frontmatterSchema.extend({
      title_en: z.string().optional(),
      title_zh: z.string().optional(),
      description_en: z.string().optional(),
      description_zh: z.string().optional(),
      owner: z.string().optional(),
      status: z.enum(['draft', 'active', 'deprecated']).default('active'),
      last_reviewed: z.string().optional(),
      tags: z.array(z.string()).default([]),
      source_path: z.string().optional(),
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig();
