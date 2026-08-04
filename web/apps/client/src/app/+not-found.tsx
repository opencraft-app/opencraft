import {useRouter} from "expo-router";
import {RouteStatusScreen} from "@/ui";
import {RouteTitle} from "../features/navigation/route-title";

export default function NotFoundRoute() {
  const router = useRouter();
  return (
    <>
      <RouteTitle title="页面不存在 · VELA" />
      <RouteStatusScreen
        actionLabel="返回 VELA"
        description="这个地址不属于当前客户端。请检查链接，或返回首页重新选择 Server。"
        onAction={() => router.replace("/")}
        title="页面不存在"
      />
    </>
  );
}
