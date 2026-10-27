import { NavigationList, NavigationGroup, NavigationItem } from "../../packages/design-system-web/src/navigation";
import React, { createRef } from "react";
import { Button, DisclosureButton, IconButton, ButtonPlaceholder } from "@opencraft/design-system-web/button";
import { ControlSurface } from "@opencraft/design-system-web/control-surface";

const ref = createRef<HTMLButtonElement>();
const valid = <ControlSurface surface="floating">
  <IconButton aria-label="Open preview" ref={ref} surface="integrated"><span aria-hidden="true">+</span></IconButton>
  <Button variant="primary" size="sm" loading>Save</Button>
  <ButtonPlaceholder size="chrome" />
</ControlSurface>;
void valid;
// @ts-expect-error icon actions require an accessible name
const unnamed = <IconButton><span aria-hidden="true">+</span></IconButton>;
// @ts-expect-error appearance is a declared semantic surface, not an arbitrary style
const surface = <Button surface="glass-circle">Open</Button>;
// @ts-expect-error dimensions belong to declared roles
const size = <Button size="28px">Open</Button>;
// @ts-expect-error groups must explicitly select their surface
const group = <ControlSurface />;
void [unnamed, surface, size, group];

const navigation = <NavigationList label="Settings"><NavigationGroup><NavigationItem aria-current="page">Appearance</NavigationItem></NavigationGroup></NavigationList>;
// @ts-expect-error Navigation landmarks require an accessible name.
const unnamedNavigation = <NavigationList><NavigationGroup /></NavigationList>;
// @ts-expect-error Navigation rows choose their own material.
const floatingNavigation = <NavigationItem surface="floating">Appearance</NavigationItem>;
// @ts-expect-error Navigation row geometry belongs to its primitive.
const customNavigationSize = <NavigationItem size="lg">Appearance</NavigationItem>;
void [navigation, unnamedNavigation, floatingNavigation, customNavigationSize];

const disclosure = <DisclosureButton aria-expanded>Permissions</DisclosureButton>;
// @ts-expect-error A quiet disclosure cannot select a separate floating surface.
const floatingDisclosure = <DisclosureButton surface="floating">Permissions</DisclosureButton>;
// @ts-expect-error Disclosure feedback is owned by the primitive.
const customDisclosure = <DisclosureButton variant="primary">Permissions</DisclosureButton>;
void [disclosure, floatingDisclosure, customDisclosure];
