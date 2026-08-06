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

import { createDocsSearchTokenizer } from './search-tokenizer';
import { DEFAULT_PUBLIC_DOCS_LOCALE } from './public-locale';
import {
  resolveDocsSearchEndpoint,
  resolveDocsSearchLocale,
  type DocsSearchLocale,
} from './search-routing';

function initLightVelaOrama(locale: DocsSearchLocale) {
  const tokenizer = createDocsSearchTokenizer(locale);
  return create({
    schema: { _: 'string' },
    ...(tokenizer ? { components: { tokenizer } } : {}),
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
  const searchLocale = resolveDocsSearchLocale(pathname, locale, DEFAULT_PUBLIC_DOCS_LOCALE);
  const [tag, setTag] = useState(defaultTag);
  const client = oramaStaticClient({
    from: resolveDocsSearchEndpoint(api ?? '/api/search', searchLocale),
    initOrama: () => initLightVelaOrama(searchLocale),
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
