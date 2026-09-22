/**
 * Catalogs where studios and agencies live. Used by the popup as quick links.
 *
 * Every link was checked by opening it in a real browser on September 4, 2026.
 * Catalogs rewrite their URLs and do not set up redirects, so dead links show up here
 * on their own. Before adding a new one, open it and look at the title: Clutch and
 * GoodFirms return a 404 for a nonexistent path, not a redirect to the listing.
 *
 * Removed from the previous version:
 *   clutch.co/agencies/web-design        404, the correct path is /web-designers
 *   clutch.co/ua/kyiv/web-developers     404, there are no city pages in this form
 *   clutch.co/web-developers?employees=  the parameter filters nothing, returns the same 95,675
 *   goodfirms.co/directory/services/...  404
 *   goodfirms.co/directory/platform/...  404 for react-js
 *   upcity.com/web-design/agencies       does not open, the correct path is /web-design
 *   jobs.dou.ua/companies/?business=...  the DOU listing does not show company sites, so
 *                                        collecting from it saved zero: everything got
 *                                        filtered out as "no domain". DOU is taken through
 *                                        the server-side catalog, `pnpm cli catalog:dou`,
 *                                        which visits the profile and takes the site from there
 */
const JOB_RADAR_CATALOGS = [
  {
    group: 'Design studios',
    links: [
      ['Clutch, web design', 'https://clutch.co/web-designers'],
      ['DesignRush, web design', 'https://www.designrush.com/agency/website-design-development'],
      ['GoodFirms, web design', 'https://www.goodfirms.co/directory/platforms/top-web-design-companies'],
      ['UpCity, web design', 'https://upcity.com/web-design'],
    ],
  },
  {
    group: 'Web development',
    links: [
      ['Clutch', 'https://clutch.co/web-developers'],
      ['GoodFirms', 'https://www.goodfirms.co/companies/web-development-agency'],
      ['DesignRush', 'https://www.designrush.com/agency/web-development-companies'],
      ['Sortlist', 'https://www.sortlist.com/web-development'],
      ['The Manifest', 'https://themanifest.com/web-development/companies'],
      ['TechBehemoths', 'https://techbehemoths.com/companies/web-development'],
    ],
  },
  {
    group: 'Ukraine and nearby',
    links: [
      ['Clutch, Ukraine', 'https://clutch.co/ua/web-developers'],
      ['Clutch, Poland', 'https://clutch.co/pl/web-developers'],
      ['Clutch, Germany', 'https://clutch.co/de/web-developers'],
      ['GoodFirms, Ukraine', 'https://www.goodfirms.co/companies/web-development-agency/ua'],
      ['DesignRush, Ukraine', 'https://www.designrush.com/agency/web-development-companies/ua'],
    ],
  },
];
