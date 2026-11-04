import { useId } from "react";
import type { RegisteredPage } from "../../features/pages/service";
import type { NavigationOpenOptions } from "../../features/navigation/controller";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PageIcon } from "./PageIcon";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  BestieUnreadBadge,
  BestieUnreadLabel,
  usePagePresentation,
} from "./BestieNavigation";
import { BESTIE_PAGE } from "./bestie-context";

export function PageNavigation({
  pages,
  selected,
  currentPage = selected,
  onSelect,
  placement = "sidebar",
}: {
  pages: readonly RegisteredPage[];
  selected: string;
  currentPage?: string;
  onSelect(key: string, options?: Pick<NavigationOpenOptions, "focus">): void;
  placement?: "sidebar" | "topbar" | "toolbar";
}) {
  const presentation = usePagePresentation();
  const badgeId = useId();
  if (placement === "topbar") {
    return (
      <Tabs
        label="Topbar pages"
        variant="chrome"
        value={pages.some((page) => page.key === selected) ? selected : null}
        onValueChange={(key) => onSelect(key, { focus: "preserve" })}
        onReselect={(key) => {
          if (key !== currentPage) onSelect(key, { focus: "preserve" });
        }}
        items={pages.map((page) => {
          const Badge = page.badge;
          const { icon, image } = presentation(page);
          return {
            value: page.key,
            label: presentation(page).label,
            icon: (
              <PageIcon icon={icon} image={image} size={16} strokeWidth={2.5} />
            ),
            panelId: `shell-page-${page.key}`,
            trailing: Badge ? (
              <ContributionBoundary key={contributionKey(page)} fallback={null}>
                <Badge />
              </ContributionBoundary>
            ) : undefined,
          };
        })}
      />
    );
  }
  return pages.map((page, index) => {
    const { label, icon, image, avatar } = presentation(page);
    const Badge = page.badge;
    const badge = Badge && (
      <ContributionBoundary key={contributionKey(page)} fallback={null}>
        <Badge />
      </ContributionBoundary>
    );
    const select = () => {
      onSelect(page.key);
      document.getElementById("main-content")?.focus({ preventScroll: true });
    };
    const pageIcon = avatar ? (
      <Avatar
        key={page.key}
        src={avatar.src}
        alt=""
        fallback={label}
        shape={avatar.shape}
        size="compact"
      />
    ) : (
      <PageIcon
        key={page.key}
        icon={icon}
        image={image}
        size={16}
        strokeWidth={2.5}
      />
    );
    // The toolbar badge sits beside its icon-only button, not inside it, so
    // the button names the page and the badge describes it.
    const describedBy = badge ? `${badgeId}-${index}` : undefined;
    return placement === "toolbar" ? (
      <span className="shell-toolbar-page" key={page.key}>
        <IconButton
          aria-label={label}
          aria-describedby={describedBy}
          title={label}
          variant="chrome"
          aria-current={selected === page.key ? "page" : undefined}
          onClick={select}
          icon={pageIcon}
        />
        {badge && (
          <span id={describedBy} className="shell-toolbar-badge">
            {badge}
          </span>
        )}
      </span>
    ) : (
      <NavigationItem
        key={page.key}
        onClick={select}
        selected={selected === page.key}
        aria-current={
          selected === page.key && currentPage !== selected ? true : undefined
        }
        label={
          page.key === BESTIE_PAGE ? <BestieUnreadLabel label={label} /> : label
        }
        title={label}
        variant="row"
        trailing={
          page.key === BESTIE_PAGE ? (
            <>
              {badge}
              <BestieUnreadBadge pageKey={page.key} />
            </>
          ) : (
            badge
          )
        }
        icon={
          placement === "sidebar" ? (
            <span className="shell-page-icon">{pageIcon}</span>
          ) : undefined
        }
      />
    );
  });
}
