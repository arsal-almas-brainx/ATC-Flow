import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { signOut } from "../auth.server";

export const loader = () => redirect("/app");

export const action = ({ request }: ActionFunctionArgs) => signOut(request);
