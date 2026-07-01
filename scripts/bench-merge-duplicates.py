# FAST duplicate cleanup — runs ON the ERPNext server, where the DB is local and
# there are no REST round-trips or per-delete lock-wait timeouts. This finishes
# in minutes what the REST/Node path takes ~10-12 hours to do, because deleting a
# Lead over REST triggers Frappe's full link-scan across a 44k-record table.
#
# HOW TO RUN (needs ERPNext server / bench access — an infra task, not the app):
#   bench --site uat.elbrit.org console
#   >>> exec(open('bench-merge-duplicates.py').read())
# or:  bench --site uat.elbrit.org execute path.to.this_as_module  (if packaged)
#
# WHAT IT DOES, per code that exists as BOTH clean DR-<code> and padded DR-000<code>:
#   1. Repoints the padded Lead's Address links onto the clean Lead (dedup by
#      address_line1 + pincode — a duplicate copy is deleted, not doubled).
#   2. Deletes the padded Lead.
# Sets with NO clean DR-<code> form are skipped (left for manual review).
#
# Review before running. It commits every 200 deletions so it's resumable.

import frappe
from collections import defaultdict

def strip(c):
    return (''.join(ch for ch in str(c or '') if ch.isdigit())).lstrip('0')

def addr_key(a):
    return (str(a.get('address_line1') or '').strip().lower(), str(a.get('pincode') or '').strip())

leads = frappe.get_all('Lead', filters={'name': ['like', 'DR-%']}, fields=['name'])
groups = defaultdict(list)
for l in leads:
    code = strip(l['name'].replace('DR-', ''))
    if code:
        groups[code].append(l['name'])

removed = moved = deleted_addr = skipped_no_clean = errors = 0
processed = 0

for code, names in groups.items():
    if len(names) < 2:
        continue
    keep = 'DR-%s' % code
    if keep not in names:
        skipped_no_clean += 1
        continue
    # existing address keys on the keeper (for dedup)
    keep_addr_names = [d.parent for d in frappe.get_all(
        'Dynamic Link', filters={'parenttype': 'Address', 'link_doctype': 'Lead', 'link_name': keep}, fields=['parent'])]
    keep_keys = set()
    for an in keep_addr_names:
        a = frappe.db.get_value('Address', an, ['address_line1', 'pincode'], as_dict=True)
        if a:
            keep_keys.add(addr_key(a))

    for rem in names:
        if rem == keep:
            continue
        try:
            rem_addr_names = [d.parent for d in frappe.get_all(
                'Dynamic Link', filters={'parenttype': 'Address', 'link_doctype': 'Lead', 'link_name': rem}, fields=['parent'])]
            for an in rem_addr_names:
                a = frappe.db.get_value('Address', an, ['address_line1', 'pincode'], as_dict=True) or {}
                if addr_key(a) in keep_keys:
                    frappe.delete_doc('Address', an, force=1, ignore_permissions=1)
                    deleted_addr += 1
                else:
                    frappe.db.set_value('Dynamic Link',
                        {'parenttype': 'Address', 'parent': an, 'link_doctype': 'Lead', 'link_name': rem},
                        'link_name', keep)
                    keep_keys.add(addr_key(a))
                    moved += 1
            frappe.delete_doc('Lead', rem, force=1, ignore_permissions=1)
            removed += 1
            processed += 1
            if processed % 200 == 0:
                frappe.db.commit()
                print('committed', processed, 'removed', removed, 'moved', moved, 'errors', errors)
        except Exception as e:
            errors += 1
            print('ERROR', rem, '->', keep, ':', str(e)[:200])

frappe.db.commit()
print('DONE removed=%d movedAddr=%d deletedAddr=%d noCleanSkipped=%d errors=%d' % (removed, moved, deleted_addr, skipped_no_clean, errors))
