import { ChevronLeft, ChevronRight, X } from "lucide-react-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Image, Modal, Pressable, SafeAreaView, View } from "react-native";
import { StyleSheet } from "../styles";
import { useNativeChatCopy } from "../presentation-language";
import {
  neighboringNativeGalleryImage,
  orderedNativeGalleryImages,
  type NativeGalleryImage,
} from "./image-gallery-model";

interface NativeImageGallery {
  readonly register: (item: NativeGalleryImage) => () => void;
  readonly open: (item: NativeGalleryImage) => void;
}

const NativeImageGalleryContext = createContext<NativeImageGallery | null>(null);

export function useNativeImageGallery(): NativeImageGallery | null {
  return useContext(NativeImageGalleryContext);
}

export function NativeImageGalleryProvider({ children, scopeKey }: { readonly children: ReactNode; readonly scopeKey: string }) {
  const copy = useNativeChatCopy();
  const [items, setItems] = useState<ReadonlyMap<string, { scopeKey: string; item: NativeGalleryImage }>>(() => new Map());
  const [active, setActive] = useState<{ scopeKey: string; item: NativeGalleryImage } | null>(null);
  useEffect(() => setActive(null), [scopeKey]);
  const register = useCallback((item: NativeGalleryImage) => {
    const registrationKey = JSON.stringify([scopeKey, item.key]);
    setItems(current => {
      const previous = current.get(registrationKey)?.item;
      if (previous?.source === item.source && previous.alt === item.alt && previous.order === item.order) return current;
      return new Map(current).set(registrationKey, { scopeKey, item });
    });
    return () => setItems(current => {
      if (current.get(registrationKey)?.item.source !== item.source) return current;
      const next = new Map(current);
      next.delete(registrationKey);
      return next;
    });
  }, [scopeKey]);
  const open = useCallback((item: NativeGalleryImage) => setActive({ scopeKey, item }), [scopeKey]);
  const gallery = useMemo(() => ({ register, open }), [register, open]);
  const scopedActive = active?.scopeKey === scopeKey ? active.item : null;
  const ordered = useMemo(() => orderedNativeGalleryImages([
    ...[...items.values()].filter(entry => entry.scopeKey === scopeKey).map(entry => entry.item),
    ...(scopedActive !== null && !items.has(JSON.stringify([scopeKey, scopedActive.key])) ? [scopedActive] : []),
  ]), [items, scopeKey, scopedActive]);
  const current = scopedActive === null ? null : ordered.find(item => item.key === scopedActive.key) ?? scopedActive;
  const previous = current === null ? null : neighboringNativeGalleryImage(ordered, current.key, -1);
  const next = current === null ? null : neighboringNativeGalleryImage(ordered, current.key, 1);
  const close = () => setActive(null);
  return (
    <NativeImageGalleryContext.Provider value={gallery}>
      {children}
      {current === null ? null : <Modal animationType="fade" onRequestClose={close} presentationStyle="overFullScreen" supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]} transparent visible>
        <SafeAreaView style={styles.backdrop}>
          <View style={styles.toolbar}>
            <Pressable accessibilityLabel={copy.closeImagePreview} accessibilityRole="button" onPress={close} style={styles.control}>
              <X color="#fff" size={20} />
            </Pressable>
          </View>
          <Image accessibilityLabel={current.alt || copy.previewImage} resizeMode="contain" source={{ uri: current.source }} style={styles.preview} />
          <View style={styles.navigation}>
            {previous === null ? <View style={styles.control} /> : <Pressable accessibilityLabel={copy.previousImage} accessibilityRole="button" onPress={() => setActive({ scopeKey, item: previous })} style={styles.control}><ChevronLeft color="#fff" size={20} /></Pressable>}
            {next === null ? <View style={styles.control} /> : <Pressable accessibilityLabel={copy.nextImage} accessibilityRole="button" onPress={() => setActive({ scopeKey, item: next })} style={styles.control}><ChevronRight color="#fff" size={20} /></Pressable>}
          </View>
        </SafeAreaView>
      </Modal>}
    </NativeImageGalleryContext.Provider>
  );
}

const styles = StyleSheet.create(() => ({
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.54)" },
  toolbar: { alignItems: "center", flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 24, paddingTop: 12 },
  control: { alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(0, 0, 0, 0.54)" },
  preview: { flex: 1, marginHorizontal: 24, marginVertical: 12 },
  navigation: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 24, paddingBottom: 16 },
}));
