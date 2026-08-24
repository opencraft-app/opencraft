import { defineConfig, defineDocs, frontmatterSchema, metaSchema } from 'fumadocs-mdx/config';
import { rehypeToc } from 'fumadocs-core/mdx-plugins';
import { z } from 'zod';

export const docs = defineDocs({
  dir: '.fumadocs-content/docs',
  docs: {
    schema: frontmatterSchema.extend({
      description: z.string().optional(),
      source_path: z.string().optional(),
      // 内容最后更新日期（YYYY-MM-DD）。真源：`src/content/docs/last-updated.json`，
      // 由 `scripts/sync-fumadocs-content.mjs` 注入。**不是构建时间**。
      last_updated: z.string().optional(),
      // 正文已自带「摘要 / Summary」段时置为 true：页面顶部不再重复渲染
      // description 段落，但 description 仍用于 SEO meta。
      hide_description: z.boolean().optional(),
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
