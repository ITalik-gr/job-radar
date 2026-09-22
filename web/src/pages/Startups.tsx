import { StudiosPage } from './Studios';

/**
 * Startups are the same screen as Studios over a different slice of the database.
 * The scenario is the same: a cold letter offering help, not an application.
 *
 * Whether they need a developer shows up two ways, both already in the database:
 * how many open vacancies the adapters found, and whether the site has an ATS at all.
 */
export function StartupsPage() {
  return (
    <StudiosPage
      kind="startup"
      section="startups"
      emptyTitle="No startups yet"
      emptyHint="Run the getro source on the Sources page: it brings in startup vacancies from accelerator boards, and the companies behind them."
    />
  );
}
