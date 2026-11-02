// The signed-in account, for screens that depend on what it may do (upload, run paid checks).

import { createContext, useContext } from "react";
import type { User } from "./api";

export const UserContext = createContext<User | null>(null);
export const useUser = () => useContext(UserContext);
