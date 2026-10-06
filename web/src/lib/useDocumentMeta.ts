import { useEffect } from "react";

/**
 * Per-route title and description. Small enough not to warrant a helmet
 * dependency, and it keeps the og: tags in index.html as the shared default.
 */
export function useDocumentMeta({
  title,
  description,
}: {
  title: string;
  description: string;
}): void {
  useEffect(() => {
    document.title = title;

    const set = (selector: string, attribute: string, value: string) => {
      const node = document.head.querySelector(selector);
      if (node) node.setAttribute(attribute, value);
    };

    set('meta[name="description"]', "content", description);
    set('meta[property="og:title"]', "content", title);
    set('meta[property="og:description"]', "content", description);
  }, [title, description]);
}
