import { defineConfig, defineDocs, frontmatterSchema, metaSchema } from 'fumadocs-mdx/config';
import { rehypeToc } from 'fumadocs-core/mdx-plugins';
import { z } from 'zod';

export const docs = defineDocs({
  dir: '.fumadocs-content/docs',
  docs: {
    schema: frontmatterSchema.extend({
      description: z.string().optional(),
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

export default defineConfig({
  mdxOptions: {
    development: false,
    jsxRuntime: 'classic',
    pragma: 'React.createElement',
    pragmaFrag: 'React.Fragment',
    pragmaImportSource: 'next/dist/server/route-modules/app-page/vendored/rsc/react',
    valueToExport: ['toc'],
    remarkHeadingOptions: {
      generateToc: true,
    },
    rehypePlugins: (plugins) =>
      plugins.map((plugin) => (plugin === rehypeToc ? [rehypeToc, { exportToc: false }] : plugin)),
  },
});
