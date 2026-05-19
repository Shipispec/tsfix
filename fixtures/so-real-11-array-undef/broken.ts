// SO #69284585: TS2532 — array index access on an optional property.
// `data.companyAdmins[0]` is `CompanyAdmin | undefined`.
// https://stackoverflow.com/questions/69284585
interface CompanyAdmin {
	user: { firstName: string };
}
interface Company {
	id: string;
	companyAdmins?: CompanyAdmin[];
}

export function firstAdminName(data: Company): string {
	return data.companyAdmins[0].user.firstName;
}
