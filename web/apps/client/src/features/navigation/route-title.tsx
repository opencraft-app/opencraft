import {Stack, useFocusEffect} from "expo-router";
import {useCallback, useEffect} from "react";

export function RouteTitle({title}: {title: string}) {
  const updateDocumentTitle = useCallback(() => {
    const document = (
      globalThis as typeof globalThis & {
        document?: {title: string};
      }
    ).document;
    if (document) document.title = title;
  }, [title]);
  useEffect(updateDocumentTitle, [updateDocumentTitle]);
  useFocusEffect(updateDocumentTitle);

  return <Stack.Screen options={{title}} />;
}
