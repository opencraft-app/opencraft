import { ChatWorkbench } from "./ChatWorkbench";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; base_url?: string }>;
}) {
  const params = await searchParams;
  return (
    <ChatWorkbench
      initialSessionId={params.session_id}
      initialBaseUrl={params.base_url}
      initialWorkingDirectory={process.env.VELA_CHAT_DEFAULT_WORKDIR ?? process.cwd()}
    />
  );
}
