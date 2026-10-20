import { StudiosPage } from './Studios';

/**
 * Startups are the same screen as Leads over a different slice of the database.
 * The scenario is the same: a cold letter offering help, not an application.
 *
 * Whether they need a developer shows up as the hiring badge: a board saw them
 * posting developer roles in the last weeks.
 */
export function StartupsPage() {
  return (
    <StudiosPage
      kind="startup"
      section="startups"
      emptyTitle="No startups yet"
      emptyHint="Run the getro, hn:hiring or yc sources on the Sources page: they bring in startups and the founders behind them."
    />
  );
}
