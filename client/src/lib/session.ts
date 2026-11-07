// The signed-in account, for screens that depend on what it may do (upload, run paid checks).

import { createContext, useContext, useEffect, useState } from "react";
import { api, type User } from "./api";

export const UserContext = createContext<User | null>(null);
export const useUser = () => useContext(UserContext);

// The read-only demo account (server/src/guest.ts): screens show what was found and offer nothing that changes data.
// The server refuses every change in guest mode anyway; this only keeps the interface from offering them.
export const useGuest = () => useUser()?.guest === true;

// Whether this server is the public demo (guest mode), asked once per page load.
let guestServer: Promise<boolean> | null = null;
export function useGuestServer(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    guestServer ??= api.guestAvailable().then((r) => r.available, () => false);
    void guestServer.then(setOn);
  }, []);
  return on;
}
