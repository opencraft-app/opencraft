// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { createContext, useContext } from "react";
import type { PropsWithChildren } from "react";
import type { Repositories } from "../repositories/types";

const RepositoryContext = createContext<Repositories | null>(null);

export const RepositoryProvider = ({ children, value }: PropsWithChildren<{ value: Repositories }>) => {
  return <RepositoryContext value={value}>{children}</RepositoryContext>;
};

export const useRepositories = () => {
  const repositories = useContext(RepositoryContext);
  if (repositories === null) throw new Error("OpenCraft requires account-bound repositories");
  return repositories;
};
export type { Repositories };
