# Job Search Intelligence

**Status: Prototype — in development.** This repository currently contains project documentation and a `.gitignore`; application code and a working demo have not been implemented.

A private-first application that turns application confirmations and recruiter conversations into a reviewable job-search timeline. Its purpose is to make important events easier to follow while preserving the evidence behind each event.

## Planned scope

- Import relevant application and recruiter-message events through Microsoft Graph.
- Organize events into a timeline with links to their source evidence.
- Let the owner review and correct event associations before relying on them.
- Support follow-up and outcome analysis without inventing application status or treating an inferred event as confirmed.

## Intended stack

React, TypeScript, Microsoft Graph, Cloudflare Workers, and Cloudflare D1. Integration details, authentication, and the data model will be finalized during implementation.

## Data boundaries

The public demo will use synthetic data. Real mailbox messages, recruiter conversations, access tokens, and private application records must stay outside Git. Any future live-mail integration requires owner authentication and deliberately scoped access.

This application will have its own Worker and D1 database. Its private records will not be shared with the portfolio database or used as retrieval sources for Ask Branden.

## Getting started

Clone the repository to begin implementation:

```sh
git clone https://github.com/BrandenFarmerDev/job-search-intelligence.git
cd job-search-intelligence
```

There are no install, development, test, or deployment commands yet. Add reproducible setup and quality checks alongside the first application implementation. Keep secrets in local ignored configuration or Worker secrets; `VITE_` variables are public.

## Portfolio

- [Project outline](https://brandenfarmer.com/work#job-search-intelligence)
- [Portfolio source](https://github.com/BrandenFarmerDev/branden-farmer-portfolio)
