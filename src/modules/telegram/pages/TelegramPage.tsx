import type { ModuleRouteProps } from "@/core/modules/types.server";
import { listChannels, recentPosts } from "../queries";
import { TelegramView } from "../components/TelegramView";

export async function TelegramPage() {
  return <TelegramPageFor active={null} />;
}

/** /m/telegram/<username> — the same view focused on that channel's feed
 *  (the list used to hardcode channels[0], making a second channel's posts
 *  unreachable). */
export async function TelegramChannelPage({ params }: ModuleRouteProps) {
  const [username] = params;
  return <TelegramPageFor active={decodeURIComponent(username ?? "")} />;
}

async function TelegramPageFor({ active }: { active: string | null }) {
  const channels = await listChannels();
  const activeChannel =
    (active ? channels.find((c) => c.username === active) : undefined) ??
    channels[0] ??
    null;
  const posts = activeChannel ? await recentPosts(activeChannel.username) : [];
  return (
    <TelegramView
      channels={channels}
      activeUsername={activeChannel?.username ?? null}
      posts={posts}
    />
  );
}
