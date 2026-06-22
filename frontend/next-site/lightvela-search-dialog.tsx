'use client';

import { create } from '@orama/orama';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { oramaStaticClient } from 'fumadocs-core/search/client/orama-static';
import { useOnChange } from 'fumadocs-core/utils/use-on-change';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  TagsList,
  TagsListItem,
} from 'fumadocs-ui/components/dialog/search';
import type { DefaultSearchDialogProps } from 'fumadocs-ui/components/dialog/search-default';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';

import { createLightVelaSearchTokenizer } from './search-tokenizer';

const DOCS_SEARCH_LOCALES = new Set(['en-us', 'zh-cn', 'zh-sg']);

function docsSearchLocaleFromPath(pathname: string | null, contextLocale: unknown): string {
  const firstSegment = pathname?.split('/').filter(Boolean)[0];
  if (firstSegment && DOCS_SEARCH_LOCALES.has(firstSegment)) return firstSegment;
  if (typeof contextLocale === 'string' && DOCS_SEARCH_LOCALES.has(contextLocale)) return contextLocale;
  return 'zh-cn';
}

function initLightVelaOrama() {
  return create({
    schema: { _: 'string' },
    components: {
      tokenizer: createLightVelaSearchTokenizer(),
    },
  });
}

export function LightVelaSearchDialog({
  type: _type,
  defaultTag,
  tags = [],
  api,
  delayMs,
  allowClear = false,
  links = [],
  footer,
  ...props
}: DefaultSearchDialogProps) {
  const { locale } = useI18n();
  const pathname = usePathname();
  const searchLocale = docsSearchLocaleFromPath(pathname, locale);
  const [tag, setTag] = useState(defaultTag);
  const client = oramaStaticClient({
    from: api,
    initOrama: initLightVelaOrama,
    locale: searchLocale,
    tag,
  });
  const { search, setSearch, query } = useDocsSearch({
    client,
    delayMs,
  });

  const defaultItems = useMemo(() => {
    if (links.length === 0) return null;

    return links.map(([name, link]) => ({
      type: 'page' as const,
      id: name,
      content: name,
      url: link,
    }));
  }, [links]);

  useOnChange(defaultTag, (value) => {
    setTag(value);
  });

  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : defaultItems} />
      </SearchDialogContent>
      <SearchDialogFooter>
        {tags.length > 0 && (
          <TagsList tag={tag} onTagChange={setTag} allowClear={allowClear}>
            {tags.map((item) => (
              <TagsListItem key={item.value} value={item.value}>
                {item.name}
              </TagsListItem>
            ))}
          </TagsList>
        )}
        {footer}
      </SearchDialogFooter>
    </SearchDialog>
  );
}
