import { createContext, useContext } from "react";
import type { PropsWithChildren } from "react";
import { createRepositories } from "@/repositories/http-repositories";
import type { Repositories } from "@/repositories/types";

const repositories = createRepositories();

const RepositoryContext = createContext<Repositories>(repositories);

export const RepositoryProvider = ({ children }: PropsWithChildren) => {
  return <RepositoryContext value={repositories}>{children}</RepositoryContext>;
};

export const useRepositories = () => useContext(RepositoryContext);
