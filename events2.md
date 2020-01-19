# Event subsystem APIs

Version 2.

## Authorization

The `POST` API requires authorization. It is a shared secret, which is passed either as
`?access_token=...` query argument or as `X-GitWed-Secret: ...` header.


## User-facing pages

This is mostly configured through gitwed-data repo.

`GET /events2/`

List events. Supports query parameters, see below.

`GET /events2/:id`

Page for a specific event. Supports editing if user has the permission.

This is to be moved to `/events/` once fully deployed and tested.
However, the APIs will stay at `/api/v2`.

## JSON APIs

`POST /api/v2/events`

Create a new event (if no `eventId` attribute in payload), or
update an existing one (with `eventId` in payload).
If `eventId` is specified, the event has to already exist (that is events cannot be created
with a user-supplied ID).

The payload can be a single event object, or a number of them in a JSON array.
In case an array is passed, if any event fails validation the entire update is discarded
and error code is returned.

Input schema:

```typescript
export interface PostalAddress {
    latitude?: number;
    longitude?: number;
    addressLocality: string // city
    streetAddress?: string
    addressCountry?: string // "PL", "US", ... https://en.wikipedia.org/wiki/ISO_3166-1#Officially_assigned_code_elements
    postalCode?: string
}

export interface EventTranslation {
    lang: string;
    name?: string;
    description?: string;
    speakerBio?: string;
}

export interface EventPostData {
    // basic event data
    eventId?: number;
    startDate: string; // "2016-01-05"
    endDate?: string;
    name: string; // "Lecture with J. Random Teacher"
    organizer: string; // "wroclaw"
    location: PostalAddress;

    // extended event data
    startTime?: string; // "20:00"
    description: string; // "<p>The lecture will be about ...</p>"
    speakerBio?: string; // "<p><b>J. Random Teacher</b> was born in 1981...</p>"

    // localization support
    lang: string; // ISO language code like "pl", "en", "en-US", ...
    translations?: EventTranslation[];

    // only in post data
    editorEmail: string;
}
```

Body of the `POST` request is `EventPostData | EventPostData[]`.

The field `editorEmail` is not returned when querying the event later, 
and is only stored in git log.
The extended event data is not returned when querying for multiple events.

`GET /api/v2/events/:id`

Get full data for a specific event. Event IDs are numeric.

`GET /api/v2/events`

List events. Supports query parameters, see below.

## Event query parameters

Following parameters are supported (with examples):

* `start=2017-03-22` - only list events that don't end before given date; by default current date minus 3 days is used
* `stop=2020-03-22` - only list events that start before the given date; by default `9999-12-31`
* `count=10` - return given number of results; defaults to `100`
* `skip=10` - skip given number of results; defaults to `0`
* `organizer=wroclaw` - only return events assigned to given organizer
* `country=PL` - only return events assigned to organizers in given country

## Localization

When querying events, you can supply `?lang=es` or similar argument.
If you do so, the `translations` property is not returned, and instead the translation
is applied to the fields in the main object.

This is (currently) only supported when querying events, not when updating.
