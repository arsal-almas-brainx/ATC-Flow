/**
 * Store form fields, shared by the Add store page and a store's Settings so
 * the two never drift apart. Fields only — each page supplies its own form,
 * submit buttons and messages.
 */

export type StoreDetailsValues = {
  name: string;
  url: string;
  productUrls: string;
  discountCode: string;
  searchQuery: string;
  slackChannel: string;
  speedCollectionUrl: string;
};

export const EMPTY_DETAILS: StoreDetailsValues = {
  name: "",
  url: "",
  productUrls: "",
  discountCode: "",
  searchQuery: "",
  slackChannel: "",
  speedCollectionUrl: "",
};

export function StoreDetailsFields({ values }: { values: StoreDetailsValues }) {
  return (
    <>
      <s-text-field label="Name" name="name" value={values.name} placeholder="Wonderfold EU" />
      <s-url-field
        label="Store URL"
        name="url"
        value={values.url}
        placeholder="https://example.com"
        details="The storefront's address — the domain shoppers use."
      />
      <s-text-area
        label="Product URLs (optional)"
        name="productUrls"
        rows={3}
        value={values.productUrls}
        details="One per line. Each run tests one of these at random. Leave blank to pick an in-stock best seller automatically."
      />
      <s-text-field
        label="Discount code (optional)"
        name="discountCode"
        value={values.discountCode}
        details="Applied on every check. Leave blank to skip the discount check."
      />
      <s-text-field
        label="Search query (optional)"
        name="searchQuery"
        value={values.searchQuery}
        details="Typed into the store's search. Leave blank to search for the tested product's name."
      />
      <s-text-field
        label="Client Slack channel ID (optional)"
        name="slackChannel"
        value={values.slackChannel}
        placeholder="C0123ABCD"
        details="This client's reports go here, alongside the PDC and department-head channels set in Settings. In Slack: channel details → Channel ID at the bottom."
      />
      <s-text-field
        label="Speed test collection URL (optional)"
        name="speedCollectionUrl"
        value={values.speedCollectionUrl}
        placeholder={values.url ? `${values.url}/collections/all` : "https://example.com/collections/all"}
        details="The collection page the speed test measures. Leave blank for all products (/collections/all)."
      />
    </>
  );
}

export type ScheduleValues = { enabled: boolean; period: string; frequency: string; time: string };

export const DEFAULT_SCHEDULE: ScheduleValues = {
  enabled: false,
  period: "day",
  frequency: "1",
  time: "09:00",
};

export function ScheduleFields({ values }: { values: ScheduleValues }) {
  return (
    <>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <input type="checkbox" name="enabled" defaultChecked={values.enabled} />
        Run checks on a schedule
      </label>
      <s-stack direction="inline" gap="base">
        <s-select label="Routine" name="period" value={values.period}>
          {option("day", "Daily", values.period)}
          {option("week", "Weekly", values.period)}
          {option("month", "Monthly", values.period)}
        </s-select>
        <s-select label="How often" name="frequency" value={values.frequency}>
          {option("1", "Once", values.frequency)}
          {option("2", "Twice", values.frequency)}
        </s-select>
        <s-text-field label="Start time (EST, 24h)" name="time" value={values.time} placeholder="09:00" />
      </s-stack>
      <s-text color="subdued">
        Each scheduled run does a flow test (desktop + mobile) and a speed test, and posts one
        report to Slack. Twice is spread evenly: daily 09:00 means 9 AM and 9 PM; weekly means
        Monday and Thursday; monthly means the 1st and 15th.
      </s-text>
    </>
  );
}

/**
 * A select option that marks itself selected. Setting only the select's value
 * isn't enough: after in-app navigation the select gets its value before its
 * options exist, and falls back to the first one.
 */
function option(value: string, label: string, current: string) {
  return (
    <s-option key={value} value={value} {...(value === current ? { selected: true } : {})}>
      {label}
    </s-option>
  );
}

export function StorefrontPasswordField({ saved }: { saved: boolean }) {
  return (
    <s-password-field
      label="Storefront password (optional)"
      name="storefrontPassword"
      details={
        saved
          ? "A password is saved. Type a new one to replace it, or leave blank and save to clear it."
          : "Only while the store is password protected (Online Store → Preferences → Password protection)."
      }
    />
  );
}

export function WebBotAuthFields({ expires }: { expires: string }) {
  return (
    <>
      <s-paragraph>
        Authorizes the real browser past Shopify&apos;s bot protection — without it, flow tests are
        skipped. Create a signature in the store&apos;s Shopify Admin → Online Store → Preferences →
        Crawler access, then paste its values here. It expires after at most 3 months.
      </s-paragraph>
      <s-password-field label="Signature" name="signature" details="From Shopify Admin's Crawler access page." />
      <s-password-field
        label="Signature-Input"
        name="signatureInput"
        details="From the same page, alongside Signature."
      />
      <s-date-field
        label="Expires"
        name="expiresAt"
        value={expires}
        details="The expiry date Shopify Admin showed for this signature."
      />
    </>
  );
}

/** Reads the store details fields from a submitted form. */
export function detailsFromForm(form: FormData): StoreDetailsValues {
  const get = (k: keyof StoreDetailsValues) => String(form.get(k) ?? "");
  return {
    name: get("name"),
    url: get("url"),
    productUrls: get("productUrls"),
    discountCode: get("discountCode"),
    searchQuery: get("searchQuery"),
    slackChannel: get("slackChannel"),
    speedCollectionUrl: get("speedCollectionUrl"),
  };
}
