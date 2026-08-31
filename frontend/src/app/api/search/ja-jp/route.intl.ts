import { createLocaleSearch } from '@next-site/search';

export const dynamic = 'force-static';

export const GET = createLocaleSearch('ja-jp').staticGET;
