export const en = {
  common: {
    timezone: "Time zone",
    reference: "Reference",
    status: "Status",
    account: "Account",
    customerNumber: "Customer number",
    contact: "Contact",
    callbackPhone: "Callback phone",
    issue: "Issue",
    when: "When",
    technician: "Technician",
    viewReservation: "View reservation",
    cancelReservation: "Cancel reservation",
  },
  status: {
    pending: "Pending approval — not yet confirmed",
    confirmed: "Confirmed",
    declined: "Declined",
    expired: "Expired",
    cancelled: "Cancelled",
    completed: "Completed",
  },
  email: {
    footer: {
      login: "You received this because someone entered this email address on the {org} booking page.",
      customer: "You received this because a remote support request was made for your account with {org}.",
      staff: "You received this because you are on the {org} technical-service team.",
    },
    customerLogin: {
      subject: "Your link to book remote support",
      button: "Book a remote support session",
      body: "Use the button below to book a remote support session. The link expires in 15 minutes and can be used once.",
      ignore: "If you didn't request this, you can ignore this email.",
    },
    staffLogin: {
      subject: "Sign in to {org} scheduling",
      button: "Sign in",
      body: "This sign-in link expires in 15 minutes.",
    },
    requestReceived: {
      subject: "Request received — not yet confirmed ({ref})",
      intro:
        "Your reservation request has been received. Your appointment is not yet confirmed. We will email you once our technical-service team has reviewed it.",
    },
    newRequest: {
      subject: "New remote support request {ref} — {when}",
      intro: "A new remote support request is waiting for approval.",
      approveMe: "Approve & assign to me",
      approve: "Approve / assign…",
      propose: "Propose another time",
      details: "Open details",
    },
    confirmed: {
      subject: "Confirmed: remote support on {when} ({ref})",
      intro: "Your remote support appointment is confirmed.",
      call: "A technician will telephone you at {phone} at the appointment time. Please have your computer turned on and {tool} ready.",
    },
    assigned: {
      subject: "{ref} confirmed — assigned to {tech}",
      intro: "{approver} approved this request and assigned {tech}.",
    },
    declined: {
      subject: "We couldn't confirm your request ({ref})",
      intro: "Unfortunately we couldn't confirm your requested time.",
      reason: "Reason: {reason}",
      rebook: "Choose another time",
    },
  },
  web: {
    /* filled in Task 12 */
  },
} as const;
