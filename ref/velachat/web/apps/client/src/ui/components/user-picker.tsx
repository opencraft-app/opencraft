import { useState, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {
  ClearableSearchField,
  SearchEmptyCard,
} from "./clearable-search-field";

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
      <ClearableSearchField
        accessibilityLabel={accessibilityLabel}
        clearAccessibilityLabel={clearAccessibilityLabel}
        onChangeText={setQuery}
        placeholder={placeholder}
        value={query}
      />
      {noMatches
        ? (emptyContent ?? (
            <SearchEmptyCard
              description={emptyDescription}
              title={emptyTitle}
            />
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
    minHeight: theme.recipes.control.rowHeight,
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
