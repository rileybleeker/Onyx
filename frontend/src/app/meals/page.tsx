import { redirect } from "next/navigation";

// /meals was merged into /nutrition (renamed to "Nutrition / Meal Timing")
// on 2026-05-23. Keep this file as a redirect so existing bookmarks /
// shared links don't 404.
export default function MealsRedirect() {
  redirect("/nutrition");
}
