import { NextEmbedDemo } from "./NextEmbedDemo";

interface NextEmbedDemoPageProps {
  searchParams: Promise<{
    base_url?: string;
    session_id?: string;
  }>;
}

export default async function NextEmbedDemoPage({
  searchParams,
}: NextEmbedDemoPageProps) {
  const params = await searchParams;
  const baseUrl = params.base_url?.trim() || undefined;
  const sessionId = params.session_id?.trim() || undefined;

  return <NextEmbedDemo baseUrl={baseUrl} sessionId={sessionId} />;
}
