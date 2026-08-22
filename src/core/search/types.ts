/** A search hit shown in the ⌘K bar; selecting it navigates to `href`. */
export interface CommandSearchHit {
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}
