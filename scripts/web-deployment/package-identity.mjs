export const PUBLIC_PACKAGE_NAME = '@opencraft-app/opencraft';
export const PUBLIC_RESOURCE_PACKAGE = '@opencraft-app/opencraft-web-assets';

export function assertPackageName(name) {
  if (typeof name !== 'string' || name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
    throw new Error('Invalid npm distribution package name');
  return name;
}

// Packaging bakes these deployment defaults into every shipped Node entrypoint.
export const PACKAGE_NAME = assertPackageName(process.env.OPENCRAFT_NPM_PACKAGE_NAME || PUBLIC_PACKAGE_NAME);
export const RESOURCE_PACKAGE = assertPackageName(process.env.OPENCRAFT_NPM_RESOURCE_PACKAGE_NAME || PUBLIC_RESOURCE_PACKAGE);
