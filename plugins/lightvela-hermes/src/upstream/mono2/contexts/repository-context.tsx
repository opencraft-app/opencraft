// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { createContext, useContext } from "react";
import type { PropsWithChildren } from "react";
import { createRepositories } from "../repositories/http-repositories";
import type { Repositories } from "../repositories/types";

const repositories = createRepositories();

const RepositoryContext = createContext<Repositories>(repositories);

export const RepositoryProvider = ({ children, value = repositories }: PropsWithChildren<{ value?: Repositories }>) => {
  return <RepositoryContext value={value}>{children}</RepositoryContext>;
};

export const useRepositories = () => useContext(RepositoryContext);
export type { Repositories };
