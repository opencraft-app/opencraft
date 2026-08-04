import { useState, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Search from "lucide-react-native/icons/search";
import X from "lucide-react-native/icons/x";

import { velaTheme } from "../tokens";

export interface UserPickerSection<T> {
  emptyText?: string;
  hideWhenEmpty?: boolean;
  id: string;
  items: T[];
  title: string;
}

export interface UserPickerProps<T> {
  accessibilityLabel: string;
  clearAccessibilityLabel?: string;
  emptyContent?: ReactNode;
  emptyDescription: string;
  emptyTitle: string;
  getItemKey(item: T): string;
  getSearchValues(item: T): string[];
  placeholder?: string;
  renderItem(item: T, sectionId: string): ReactElement;
  sections: UserPickerSection<T>[];
}

export function UserPicker<T>({
  accessibilityLabel,
  clearAccessibilityLabel = "清除成员搜索",
  emptyContent,
  emptyDescription,
  emptyTitle,
  getItemKey,
  getSearchValues,
  placeholder = "搜索成员",
  renderItem,
  sections,
}: UserPickerProps<T>) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searching = Boolean(normalizedQuery);
  const visibleSections = sections.map((section) => ({
    ...section,
    visibleItems: searching
      ? section.items.filter((item) =>
          getSearchValues(item).some((value) =>
            value.toLocaleLowerCase().includes(normalizedQuery),
          ),
        )
      : section.items,
  }));
  const noMatches =
    searching &&
    visibleSections.every((section) => section.visibleItems.length === 0);

  return (
    <View style={styles.root}>
      <View style={styles.search}>
        <Search
          color={velaTheme.semantic.color.iconMuted}
          size={velaTheme.semantic.icon.size.small}
          strokeWidth={velaTheme.semantic.icon.stroke.regular}
        />
        <TextInput
          accessibilityLabel={accessibilityLabel}
          onChangeText={setQuery}
          placeholder={placeholder}
          placeholderTextColor={velaTheme.semantic.color.fieldPlaceholder}
          style={styles.searchInput}
          value={query}
        />
        {searching ? (
          <Pressable
            accessibilityLabel={clearAccessibilityLabel}
            accessibilityRole="button"
            hitSlop={velaTheme.semantic.interaction.hitTargetInset}
            onPress={() => setQuery("")}
            style={styles.searchClear}
          >
            <X
              color={velaTheme.semantic.color.iconMuted}
              size={velaTheme.semantic.icon.size.small}
              strokeWidth={velaTheme.semantic.icon.stroke.regular}
            />
          </Pressable>
        ) : null}
      </View>
      {noMatches
        ? (emptyContent ?? (
            <View style={styles.searchEmpty}>
              <Text style={styles.searchEmptyTitle}>{emptyTitle}</Text>
              <Text style={styles.emptyText}>{emptyDescription}</Text>
            </View>
          ))
        : null}
      {!noMatches
        ? visibleSections.map((section) => {
            const hideSection = searching
              ? section.visibleItems.length === 0
              : section.items.length === 0 && section.hideWhenEmpty;
            if (hideSection) {
              return null;
            }
            return (
              <View
                key={section.id}
                testID={`user-picker-section-${section.id}`}
              >
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                  <Text style={styles.sectionCount}>
                    {searching
                      ? `${section.visibleItems.length} / ${section.items.length}`
                      : section.items.length}
                  </Text>
                </View>
                {section.visibleItems.length > 0 ? (
                  <View style={styles.section}>
                    {section.visibleItems.map((item) => (
                      <View key={getItemKey(item)}>
                        {renderItem(item, section.id)}
                      </View>
                    ))}
                  </View>
                ) : section.emptyText ? (
                  <View style={styles.sectionEmpty}>
                    <Text style={styles.emptyText}>{section.emptyText}</Text>
                  </View>
                ) : null}
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
    textAlign: "center",
  },
  root: {
    gap: theme.spacing.sm,
  },
  search: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    height: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.md,
  },
  searchClear: {
    alignItems: "center",
    height: theme.recipes.iconControl.compactSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.compactSize,
  },
  searchEmpty: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.borderSection,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xl,
  },
  searchEmptyTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  searchInput: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    ...theme.semantic.typography.bodyCompact,
    minWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  section: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderRadius: theme.semantic.radius.control,
    overflow: "hidden",
  },
  sectionCount: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.captionEmphasis,
  },
  sectionEmpty: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: theme.recipes.managementWorkspace.rowMinHeight,
    paddingHorizontal: theme.spacing.lg,
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
  },
  sectionTitle: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
}));
